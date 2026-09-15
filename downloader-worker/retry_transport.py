"""Small retry layer for transient media-CDN stalls.

Only media hosts already allow-listed by the downloader are retried. Source-page
requests are intentionally untouched so this cannot become a generic proxy retry.
"""
import os
import time
from urllib.parse import urlparse

from curl_cffi import requests

MEDIA_SUFFIXES = ('surrit.com', 'nineyu.com')
MAX_ATTEMPTS = max(1, int(os.getenv('UPSTREAM_RETRY_ATTEMPTS', '3')))
BACKOFF_SECONDS = max(0.0, float(os.getenv('UPSTREAM_RETRY_BACKOFF', '0.35')))

_original_get = getattr(requests, '_downloader_original_get', requests.get)
setattr(requests, '_downloader_original_get', _original_get)


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


def retrying_get(url, *args, **kwargs):
    if not _is_media_url(url) or MAX_ATTEMPTS <= 1:
        return _original_get(url, *args, **kwargs)

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return _original_get(url, *args, **kwargs)
        except Exception as exc:
            if attempt >= MAX_ATTEMPTS or not _is_transient(exc):
                raise
            delay = BACKOFF_SECONDS * (2 ** (attempt - 1))
            print(
                f'UPSTREAM_RETRY attempt={attempt + 1}/{MAX_ATTEMPTS} '
                f'host={urlparse(str(url)).hostname or ""} reason={type(exc).__name__}',
                flush=True,
            )
            if delay:
                time.sleep(delay)


def install():
    if requests.get is retrying_get:
        return
    requests.get = retrying_get
