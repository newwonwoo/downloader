import json
import re
import struct
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urljoin

from curl_cffi import requests as curl_requests

ALLOWED_SUFFIXES = ("surrit.com", "nineyu.com")
SESSION = curl_requests.Session(impersonate="chrome")
MAX_REDIRECTS = 3
MAX_RANGE_BYTES = 2 * 1024 * 1024
MAX_UNRANGED_RESPONSE = 3 * 1024 * 1024
MAX_BUNDLE_ITEMS = 2
MAX_BUNDLE_BYTES = 3_500_000
BUNDLE_WORKERS = 2
BUNDLE_TIMEOUT = 6
RANGE_RE = re.compile(r"^bytes=(\d+)-(\d*)$", re.I)
BUNDLE_MAGIC = b"NJB1"


def _allowed_url(value: str):
    try:
        url = urlparse(value)
    except Exception:
        return None
    host = (url.hostname or "").lower()
    if url.scheme != "https":
        return None
    if url.username or url.password or url.port not in (None, 443):
        return None
    if not any(host == suffix or host.endswith("." + suffix) for suffix in ALLOWED_SUFFIXES):
        return None
    return value


def _parse_range(value, cap_bytes=None):
    if not value:
        return None
    match = RANGE_RE.match(value.strip())
    if not match:
        return None
    start = int(match.group(1))
    requested_end = int(match.group(2)) if match.group(2) else None
    if requested_end is not None and requested_end < start:
        return None
    end = requested_end
    if cap_bytes:
        capped_end = start + cap_bytes - 1
        end = capped_end if end is None else min(end, capped_end)
    return start, end


def _normalize_range(value):
    return _parse_range(value, MAX_RANGE_BYTES)


def _header_profiles(range_header=None):
    base = {
        "Accept": "*/*",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.5",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    if range_header:
        base["Range"] = range_header
    return [
        {
            **base,
            "Referer": "https://njavtv.com/",
            "Origin": "https://njavtv.com",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "cross-site",
        },
        {**base, "Referer": "https://njavtv.com/"},
        base,
    ]


def _request_once(session, target, headers, timeout=20):
    current = target
    response = None
    for _ in range(MAX_REDIRECTS + 1):
        response = session.get(
            current,
            headers=headers,
            timeout=timeout,
            allow_redirects=False,
        )
        if response.status_code not in (301, 302, 303, 307, 308):
            return response
        location = response.headers.get("location")
        if not location:
            return response
        next_url = urljoin(current, location)
        if not _allowed_url(next_url):
            return response
        current = next_url
    return response


def _request_with_profiles(target, range_header=None, session=None, timeout=20):
    client = session or SESSION
    last = None
    for profile, headers in enumerate(_header_profiles(range_header), start=1):
        response = _request_once(client, target, headers, timeout=timeout)
        last = (profile, response)
        if response.status_code not in (401, 403):
            break
    return last


def _slice_range_if_needed(body, range_header, status_code):
    if not range_header or status_code != 200:
        return body
    parsed = _parse_range(range_header)
    if parsed is None:
        raise ValueError("invalid range")
    start, requested_end = parsed
    if start >= len(body):
        raise RuntimeError("range out of bounds")
    end = len(body) - 1 if requested_end is None else min(requested_end, len(body) - 1)
    return body[start:end + 1]


def _bundle_fetch(target, range_header=None):
    if not _allowed_url(target):
        raise ValueError("invalid media url")
    if range_header and _parse_range(range_header) is None:
        raise ValueError("invalid range")
    session = curl_requests.Session(impersonate="chrome")
    result = _request_with_profiles(
        target,
        range_header,
        session=session,
        timeout=BUNDLE_TIMEOUT,
    )
    if result is None:
        raise RuntimeError("no response")
    _, response = result
    if response.status_code not in (200, 206):
        raise RuntimeError(f"upstream {response.status_code}")
    body = _slice_range_if_needed(response.content, range_header, response.status_code)
    if len(body) > MAX_BUNDLE_BYTES:
        raise RuntimeError("segment too large")
    return body


class handler(BaseHTTPRequestHandler):
    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type")
        self.end_headers()

    def _handle_bundle(self, qs):
        items = []
        for index in range(MAX_BUNDLE_ITEMS):
            raw_url = (qs.get(f"u{index}", [""])[0] or "").strip()
            if not raw_url:
                break
            if not _allowed_url(raw_url):
                return self._send_json(400, {
                    "ok": False,
                    "code": "INVALID_BUNDLE_URL",
                    "message": "허용되지 않은 묶음 미디어 주소입니다.",
                })
            raw_range = (qs.get(f"r{index}", [""])[0] or "").strip() or None
            if raw_range and _parse_range(raw_range) is None:
                return self._send_json(416, {
                    "ok": False,
                    "code": "INVALID_BUNDLE_RANGE",
                    "message": "지원하지 않는 묶음 바이트 범위입니다.",
                })
            items.append((raw_url, raw_range))

        if not items:
            return self._send_json(400, {
                "ok": False,
                "code": "EMPTY_BUNDLE",
                "message": "묶음 미디어가 비어 있습니다.",
            })

        try:
            with ThreadPoolExecutor(max_workers=min(BUNDLE_WORKERS, len(items))) as pool:
                bodies = list(pool.map(lambda pair: _bundle_fetch(*pair), items))

            payload = bytearray(BUNDLE_MAGIC)
            payload.extend(struct.pack(">H", len(bodies)))
            for body in bodies:
                if len(payload) + 4 + len(body) > MAX_BUNDLE_BYTES:
                    return self._send_json(413, {
                        "ok": False,
                        "code": "BUNDLE_TOO_LARGE",
                        "message": "영상 묶음이 응답 한도를 초과했습니다.",
                    })
                payload.extend(struct.pack(">I", len(body)))
                payload.extend(body)

            self.send_response(200)
            self.send_header("Content-Type", "application/x-njav-bundle")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Bundle-Count", str(len(bodies)))
            self.end_headers()
            self.wfile.write(payload)
            return
        except Exception as error:
            return self._send_json(502, {
                "ok": False,
                "code": "MEDIA_BUNDLE_ERROR",
                "message": f"묶음 미디어 요청 실패: {type(error).__name__}",
            })

    def do_GET(self):
        qs = parse_qs(urlparse(self.path).query)
        if (qs.get("bundle", [""])[0] or "") == "1":
            return self._handle_bundle(qs)

        target = (qs.get("url", [""])[0] or "").strip()
        if not _allowed_url(target):
            return self._send_json(400, {
                "ok": False,
                "code": "INVALID_MEDIA_URL",
                "message": "허용되지 않은 미디어 주소입니다.",
            })

        client_range = self.headers.get("Range")
        normalized_range = _normalize_range(client_range)
        if client_range and normalized_range is None:
            return self._send_json(416, {
                "ok": False,
                "code": "INVALID_RANGE",
                "message": "지원하지 않는 바이트 범위입니다.",
            })
        range_header = None
        if normalized_range:
            range_header = f"bytes={normalized_range[0]}-{normalized_range[1]}"

        try:
            result = _request_with_profiles(target, range_header)
            if result is None:
                raise RuntimeError("no response")
            profile, response = result
            raw_body = response.content
            status = response.status_code
            content_range = response.headers.get("content-range")
            accept_ranges = response.headers.get("accept-ranges")

            if normalized_range and status == 200:
                start, end = normalized_range
                total = len(raw_body)
                if start >= total:
                    return self._send_json(416, {
                        "ok": False,
                        "code": "RANGE_OUT_OF_BOUNDS",
                        "message": "요청 범위가 미디어 크기를 벗어났습니다.",
                    })
                end = min(end, total - 1)
                raw_body = raw_body[start:end + 1]
                status = 206
                content_range = f"bytes {start}-{end}/{total}"
                accept_ranges = "bytes"

            if not normalized_range and len(raw_body) > MAX_UNRANGED_RESPONSE:
                return self._send_json(413, {
                    "ok": False,
                    "code": "MEDIA_RANGE_REQUIRED",
                    "message": "대용량 미디어는 분할 요청이 필요합니다.",
                    "size": len(raw_body),
                })

            self.send_response(status)
            content_type = response.headers.get("content-type") or "application/octet-stream"
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(raw_body)))
            if content_range:
                self.send_header("Content-Range", content_range)
            if accept_ranges or normalized_range:
                self.send_header("Accept-Ranges", accept_ranges or "bytes")
            for name in ("etag", "last-modified"):
                value = response.headers.get(name)
                if value:
                    self.send_header(name.title(), value)
            self.send_header("Cache-Control", "private, max-age=120")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Media-Profile", str(profile))
            self.end_headers()
            self.wfile.write(raw_body)
        except Exception as error:
            return self._send_json(502, {
                "ok": False,
                "code": "MEDIA_PROXY_ERROR",
                "message": f"미디어 요청 실패: {type(error).__name__}",
            })
