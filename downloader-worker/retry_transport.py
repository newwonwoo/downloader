"""Media-CDN transport tuning for HLS segment downloads.

Only media hosts already allow-listed by the downloader are touched. Source-page
requests remain on the normal curl_cffi path so these optimizations cannot turn the
worker into a generic proxy transport.
"""
import os
import threading
import time
from urllib.parse import urlparse

from curl_cffi import requests

MEDIA_SUFFIXES = ('surrit.com', 'nineyu.com')
MAX_ATTEMPTS = max(1, int(os.getenv('UPSTREAM_RETRY_ATTEMPTS', '3')))
BACKOFF_SECONDS = max(0.0, float(os.getenv('UPSTREAM_RETRY_BACKOFF', '0.35')))
SESSION_REUSE = os.getenv('UPSTREAM_SESSION_REUSE', '1') != '0'
STRIP_REVALIDATION = os.getenv('UPSTREAM_STRIP_REVALIDATION', '1') != '0'
SLOW_REQUEST_SECONDS = max(0.0, float(os.getenv('UPSTREAM_SLOW_LOG_SECONDS', '3.0')))

_original_get = getattr(requests, '_downloader_original_get', requests.get)
setattr(requests, '_downloader_original_get', _original_get)
_thread_local = threading.local()


def _is_media_url(url):
    try:
        host = (urlparse(str(url)).hostname or '').lower()
        return any(host == suffix or host.endswith('.' + suffix) for suffix in MEDIA_SUFFIXES)
    except Exception:
        return False


def _is_transient(exc):
    text = f'{type(exc).__name__}: {exc}'.lower()
    return (
        'timeout' in text
        or 'timed out' in text
        or 'curl: (28)' in text
        or 'curl: (18)' in text
        or 'curl: (56)' in text
        or 'recv failure' in text
        or 'partial file' in text
    )


def _session_for_thread():
    session = getattr(_thread_local, 'media_session', None)
    if session is None:
        # One persistent curl handle per download worker thread. This preserves
        # connection/TLS state without sharing a Session across concurrent threads.
        session = requests.Session(impersonate='chrome')
        _thread_local.media_session = session
    return session


def _reset_thread_session():
    session = getattr(_thread_local, 'media_session', None)
    _thread_local.media_session = None
    if session is not None:
        try:
            session.close()
        except Exception:
            pass


def _media_kwargs(kwargs):
    tuned = dict(kwargs)
    if STRIP_REVALIDATION:
        headers = dict(tuned.get('headers') or {})
        # The old worker forced every immutable VOD segment through cache
        # revalidation. Let the media CDN serve its normal edge-cached object.
        for key in list(headers):
            if key.lower() in ('cache-control', 'pragma'):
                headers.pop(key, None)
        tuned['headers'] = headers
    if SESSION_REUSE:
        # Impersonation belongs to the persistent Session. Keeping it here would
        # rebuild per-request curl state and defeats most of the reuse benefit.
        tuned.pop('impersonate', None)
    return tuned


def _media_get_once(url, *args, **kwargs):
    tuned = _media_kwargs(kwargs)
    if SESSION_REUSE:
        return _session_for_thread().get(url, *args, **tuned)
    return _original_get(url, *args, **tuned)


def retrying_get(url, *args, **kwargs):
    if not _is_media_url(url):
        return _original_get(url, *args, **kwargs)

    for attempt in range(1, MAX_ATTEMPTS + 1):
        started = time.monotonic()
        try:
            response = _media_get_once(url, *args, **kwargs)
            elapsed = time.monotonic() - started
            if SLOW_REQUEST_SECONDS and elapsed >= SLOW_REQUEST_SECONDS:
                print(
                    f'UPSTREAM_SLOW elapsedMs={round(elapsed * 1000)} '
                    f'host={urlparse(str(url)).hostname or ""}',
                    flush=True,
                )
            return response
        except Exception as exc:
            elapsed = time.monotonic() - started
            if SESSION_REUSE:
                # A timed-out keep-alive connection should not poison the retry.
                _reset_thread_session()
            if attempt >= MAX_ATTEMPTS or not _is_transient(exc):
                raise
            delay = BACKOFF_SECONDS * (2 ** (attempt - 1))
            print(
                f'UPSTREAM_RETRY attempt={attempt + 1}/{MAX_ATTEMPTS} '
                f'elapsedMs={round(elapsed * 1000)} '
                f'host={urlparse(str(url)).hostname or ""} reason={type(exc).__name__}',
                flush=True,
            )
            if delay:
                time.sleep(delay)


def install():
    if requests.get is retrying_get:
        return
    requests.get = retrying_get
