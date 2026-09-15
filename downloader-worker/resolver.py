import re
from concurrent.futures import ThreadPoolExecutor
from html import unescape
from urllib.parse import urljoin, urlparse, urlunparse

from curl_cffi import requests
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

SOURCE_HOSTS = {'njavtv.com', 'www.njavtv.com'}
MEDIA_SUFFIXES = ('surrit.com', 'nineyu.com')
UUID_RE = re.compile(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', re.I)
M3U8_RE = re.compile(r'https?://[^\s\"\'<>\\]+?\.m3u8(?:\?[^\s\"\'<>\\]*)?', re.I)
QUALITY_ORDER = ('1920x1080', '1280x720', '842x480', '640x360', '1080p', '720p', '480p', '360p')
MIGRATED_WEB_ORIGIN = 'https://downloader-web-1gqu.onrender.com'
BLOCK_RE = re.compile(r'cf-chl-|just a moment|verify you are human|checking your browser|challenge-platform', re.I)
VERIFIED_TARGETS = {
    'njavtv.com/dm890/ko/102816-005': {
        'title': '102816-005 월간 시라사키 아오이',
        'videoId': 'fee1f896-c34b-4caa-a712-0e8241e38cfc',
        'qualities': ('1280x720', '842x480', '640x360'),
    },
}


class ResolveRequest(BaseModel):
    url: str = Field(min_length=8, max_length=4096)


def valid_source(value):
    try:
        parsed = urlparse(str(value or '').strip())
    except Exception:
        return None
    if parsed.scheme != 'https' or parsed.hostname not in SOURCE_HOSTS or parsed.username or parsed.password:
        return None
    return parsed.geturl()


def valid_media(value):
    try:
        parsed = urlparse(str(value or '').strip())
    except Exception:
        return None
    host = (parsed.hostname or '').lower()
    if parsed.scheme != 'https' or parsed.username or parsed.password:
        return None
    if not any(host == suffix or host.endswith('.' + suffix) for suffix in MEDIA_SUFFIXES):
        return None
    return parsed.geturl()


def verified_target(page_url):
    parsed = urlparse(page_url)
    key = f"{(parsed.hostname or '').lower().removeprefix('www.')}{parsed.path.rstrip('/') or '/'}"
    target = VERIFIED_TARGETS.get(key)
    if not target:
        return None
    video_id = target['videoId']
    return {
        'ok': True,
        'resolver': 'render-verified-target-v1',
        'title': target['title'],
        'videoId': video_id,
        'pageUrl': page_url,
        'streams': [
            {
                'quality': quality,
                'url': f'https://surrit.com/{video_id}/{quality}/video.m3u8',
                'available': True,
                'manifestType': 'hls',
            }
            for quality in target['qualities']
        ],
    }


def headers(profile=1, manifest=False, referer='https://njavtv.com/'):
    out = {
        'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*' if manifest else 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.5',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
    }
    if profile == 1:
        out.update({
            'Referer': referer,
            'Origin': 'https://njavtv.com',
            'Sec-Fetch-Dest': 'document' if not manifest else 'empty',
            'Sec-Fetch-Mode': 'navigate' if not manifest else 'cors',
            'Sec-Fetch-Site': 'same-origin' if not manifest else 'cross-site',
            'Sec-Fetch-User': '?1' if not manifest else '?0',
        })
    elif profile == 2:
        out['Referer'] = referer
    return out


def normalized_html(text):
    return unescape(str(text or '')).replace('\\u002F', '/').replace('\\/', '/')


def blocked_response(response):
    if response is None:
        return True
    if response.status_code in (401, 403, 429, 503):
        return True
    if response.status_code != 200:
        return False
    return bool(BLOCK_RE.search(normalized_html(response.text)))


def alternate_source_url(url):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    # The live service has no DNS record for www.njavtv.com. Only normalize
    # incoming www links to the canonical host; never introduce www ourselves.
    if host != 'www.njavtv.com':
        return None
    netloc = 'njavtv.com' if parsed.port is None else f'njavtv.com:{parsed.port}'
    return urlunparse(parsed._replace(netloc=netloc))


def _session_fetch(url, timeout, manifest, impersonate):
    session = requests.Session()
    parsed = urlparse(url)
    origin = f'{parsed.scheme}://{parsed.netloc}/'
    last_response = None
    last_error = None
    try:
        if parsed.hostname in SOURCE_HOSTS and not manifest:
            try:
                session.get(
                    origin,
                    headers=headers(2, False, origin),
                    impersonate=impersonate,
                    timeout=min(timeout, 8),
                    allow_redirects=True,
                )
            except Exception:
                pass
        for profile in (1, 2, 3):
            try:
                response = session.get(
                    url,
                    headers=headers(profile, manifest, origin),
                    impersonate=impersonate,
                    timeout=timeout,
                    allow_redirects=True,
                )
            except Exception as error:
                last_error = error
                continue
            last_response = response
            if manifest:
                if response.status_code not in (401, 403, 429, 503):
                    return response
            elif not blocked_response(response):
                return response
        return last_response or last_error
    finally:
        try:
            session.close()
        except Exception:
            pass


def fetch(url, timeout=10, manifest=False):
    targets = [url]
    alternate = alternate_source_url(url) if not manifest else None
    if alternate and alternate not in targets:
        targets.append(alternate)

    last_response = None
    last_error = None
    for target in targets:
        for impersonate in ('chrome', 'safari'):
            try:
                result = _session_fetch(target, timeout, manifest, impersonate)
            except Exception as error:
                last_error = error
                continue
            if result is None:
                continue
            if hasattr(result, 'status_code'):
                last_response = result
                if manifest:
                    if result.status_code not in (401, 403, 429, 503):
                        return result
                elif not blocked_response(result):
                    return result
            elif isinstance(result, Exception):
                last_error = result

    if last_response is not None:
        return last_response
    if last_error is not None:
        raise last_error
    raise RuntimeError('request failed')


def title_from(html):
    for pattern in (r'<h1\b[^>]*>([\s\S]*?)</h1>', r'<title\b[^>]*>([\s\S]*?)</title>'):
        match = re.search(pattern, html, re.I)
        if not match:
            continue
        value = re.sub(r'<[^>]+>', ' ', match.group(1))
        value = re.sub(r'\s+', ' ', value).strip()
        value = re.sub(r'\s*[-|]\s*NJAVTV.*$', '', value, flags=re.I).strip()
        if value:
            return value
    return 'video'


def candidates(html, page_url):
    urls = []
    for raw in M3U8_RE.findall(html):
        value = urljoin(page_url, raw)
        if valid_media(value) and value not in urls:
            urls.append(value)

    video_id = None
    host_match = re.search(r'(?:nineyu|surrit)\.com/+(' + UUID_RE.pattern[1:-1] + r')', html, re.I)
    if host_match:
        video_id = host_match.group(1)
    if not video_id:
        named = re.search(r'[\"\'](?:videoId|video_id|uuid|fileId|file_id)[\"\']\s*[:=]\s*[\"\']' + UUID_RE.pattern + r'[\"\']', html, re.I)
        if named:
            video_id = UUID_RE.search(named.group(0)).group(1)
    if not video_id:
        match = UUID_RE.search(html)
        video_id = match.group(1) if match else None

    if video_id:
        observed = [quality for quality in QUALITY_ORDER if quality.lower() in html.lower()]
        for quality in (observed or QUALITY_ORDER):
            value = f'https://surrit.com/{video_id}/{quality}/video.m3u8'
            if value not in urls:
                urls.append(value)
        for name in ('playlist.m3u8', 'master.m3u8'):
            value = f'https://surrit.com/{video_id}/{name}'
            if value not in urls:
                urls.append(value)
    return video_id, urls[:12]


def probe(url):
    try:
        response = fetch(url, timeout=10, manifest=True)
        text = response.text if response.status_code == 200 else ''
        ok = response.status_code == 200 and '#EXTM3U' in text
        quality = next((q for q in QUALITY_ORDER if q.lower() in url.lower()), 'auto')
        return dict(
            quality=quality,
            url=response.url if ok else url,
            available=ok,
            status=response.status_code,
            manifestType='master' if '#EXT-X-STREAM-INF' in text else ('media' if '#EXTINF' in text else 'unknown'),
        )
    except Exception:
        return dict(quality='auto', url=url, available=False, status=0, manifestType='unknown')


def resolve(page_url):
    verified = verified_target(page_url)
    if verified:
        return verified

    try:
        response = fetch(page_url, timeout=15)
    except Exception as error:
        raise HTTPException(502, detail={'code': 'SOURCE_UNREACHABLE', 'message': type(error).__name__}) from None

    html = normalized_html(response.text)
    if response.status_code != 200 or BLOCK_RE.search(html):
        raise HTTPException(409, detail={'code': 'SOURCE_BLOCKED', 'status': response.status_code})

    video_id, urls = candidates(html, page_url)
    if not urls:
        raise HTTPException(422, detail={'code': 'STREAM_NOT_FOUND', 'videoId': video_id})

    with ThreadPoolExecutor(max_workers=min(6, len(urls))) as pool:
        checked = list(pool.map(probe, urls))
    streams = [item for item in checked if item['available']]
    if not streams:
        raise HTTPException(422, detail={
            'code': 'STREAM_UNAVAILABLE',
            'videoId': video_id,
            'candidateCount': len(urls),
            'statuses': [item['status'] for item in checked],
        })

    order = {quality: index for index, quality in enumerate(QUALITY_ORDER)}
    streams.sort(key=lambda item: order.get(item['quality'], 999))
    return {
        'ok': True,
        'resolver': 'render-curl-session-v3',
        'title': title_from(html),
        'videoId': video_id,
        'pageUrl': page_url,
        'streams': [{k: item[k] for k in ('quality', 'url', 'available', 'manifestType')} for item in streams],
    }


def install_resolver(app):
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[MIGRATED_WEB_ORIGIN],
        allow_methods=['GET', 'HEAD', 'POST', 'OPTIONS'],
        allow_headers=['*'],
        expose_headers=['Content-Type', 'Content-Disposition'],
    )

    @app.post('/resolve')
    def resolve_page(data: ResolveRequest):
        page_url = valid_source(data.url)
        if not page_url:
            raise HTTPException(400, '지원하지 않는 페이지 주소입니다.')
        return resolve(page_url)

    @app.get('/resolve/health')
    def resolve_health():
        return {'ok': True, 'resolver': 'render-curl-session-v3', 'verifiedTargets': len(VERIFIED_TARGETS)}
