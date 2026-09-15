import os
import re
import select
import subprocess
import threading
import time
import anyio
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from urllib.parse import quote, urljoin, urlparse

from curl_cffi import requests
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

ALLOWED = ('surrit.com', 'nineyu.com')
DOWNLOAD_WORKERS = max(1, int(os.getenv('DOWNLOAD_WORKERS', '8')))
UPSTREAM_TIMEOUT = int(os.getenv('UPSTREAM_TIMEOUT', '15'))
MAX_OBJECT_BYTES = int(os.getenv('MAX_OBJECT_BYTES', str(16 * 1024 * 1024)))
FIRST_OUTPUT_TIMEOUT = int(os.getenv('FIRST_OUTPUT_TIMEOUT', '20'))
OUTPUT_IDLE_TIMEOUT = int(os.getenv('OUTPUT_IDLE_TIMEOUT', '90'))
MAX_ACTIVE_DOWNLOADS = max(1, int(os.getenv('MAX_ACTIVE_DOWNLOADS', '2')))
DOWNLOAD_SLOTS = threading.BoundedSemaphore(MAX_ACTIVE_DOWNLOADS)
RANGE_RE = re.compile(r'^bytes=(\d+)-(\d+)$', re.I)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        'https://downloader-web-1gqu.onrender.com',
        'https://unisquads.vercel.app',
    ],
    allow_methods=['GET', 'HEAD', 'POST', 'OPTIONS'],
    allow_headers=['*'],
    expose_headers=['Content-Type', 'Content-Disposition'],
)


def allowed(url):
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or '').lower()
        return (
            parsed.scheme == 'https'
            and parsed.username is None
            and parsed.password is None
            and parsed.port in (None, 443)
            and any(host == suffix or host.endswith('.' + suffix) for suffix in ALLOWED)
        )
    except Exception:
        return False


def request_headers(range_header=None, profile=1):
    headers = {
        'Accept': '*/*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.5',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
    }
    if range_header:
        headers['Range'] = range_header
    if profile == 1:
        headers.update({
            'Referer': 'https://njavtv.com/',
            'Origin': 'https://njavtv.com',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'cross-site',
        })
    elif profile == 2:
        headers['Referer'] = 'https://njavtv.com/'
    return headers


def parse_range(range_header):
    if not range_header:
        return None
    match = RANGE_RE.match(range_header)
    if not match:
        raise RuntimeError('invalid byte range')
    start = int(match.group(1))
    end = int(match.group(2))
    if end < start:
        raise RuntimeError('invalid byte range')
    return start, end


def fetch_bytes(url, range_header=None):
    if not allowed(url):
        raise RuntimeError('unsupported media host')
    last = None
    for profile in (1, 2, 3):
        response = requests.get(
            url,
            headers=request_headers(range_header, profile),
            impersonate='chrome',
            timeout=UPSTREAM_TIMEOUT,
            allow_redirects=True,
        )
        last = response
        if response.status_code not in (401, 403):
            break

    if last is None or last.status_code not in (200, 206):
        raise RuntimeError(f'upstream {getattr(last, "status_code", 0)}')

    body = bytes(last.content)
    requested = parse_range(range_header)
    if requested and last.status_code == 200:
        start, end = requested
        if start >= len(body):
            raise RuntimeError('range out of bounds')
        body = body[start:min(end + 1, len(body))]

    if not body:
        raise RuntimeError('empty upstream body')
    if len(body) > MAX_OBJECT_BYTES:
        raise RuntimeError('media object too large')
    return body


def attrs(line):
    out = {}
    for match in re.finditer(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)', line, re.I):
        out[match.group(1).upper()] = match.group(2).strip('"')
    return out


def byte_range(raw, previous_end):
    value = str(raw or '').strip().strip('"')
    if not value:
        return None, previous_end
    pieces = value.split('@', 1)
    length = int(pieces[0])
    if length <= 0:
        raise RuntimeError('invalid HLS byte range')
    if len(pieces) == 2:
        start = int(pieces[1])
    else:
        if previous_end is None:
            raise RuntimeError('implicit HLS byte range without predecessor')
        start = previous_end + 1
    if start < 0:
        raise RuntimeError('invalid HLS byte range')
    end = start + length - 1
    return f'bytes={start}-{end}', end


def load_playlist(url):
    text = fetch_bytes(url).decode('utf-8', 'replace')
    if '#EXTM3U' not in text:
        raise RuntimeError('invalid HLS playlist')

    if '#EXT-X-STREAM-INF' in text:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        variants = []
        for index, line in enumerate(lines):
            if not line.startswith('#EXT-X-STREAM-INF'):
                continue
            meta = attrs(line)
            nxt = next((x for x in lines[index + 1:] if not x.startswith('#')), None)
            if nxt:
                variants.append((int(meta.get('BANDWIDTH', '0') or 0), urljoin(url, nxt)))
        if not variants:
            raise RuntimeError('master playlist empty')
        url = max(variants)[1]
        text = fetch_bytes(url).decode('utf-8', 'replace')

    lines = [line.strip() for line in text.splitlines()]
    sequence = 0
    key = None
    init = None
    segments = []
    pending_range = None
    previous_range_end = None

    for line in lines:
        if line.startswith('#EXT-X-MEDIA-SEQUENCE:'):
            sequence = int(line.split(':', 1)[1] or 0)
        elif line.startswith('#EXT-X-MAP:'):
            meta = attrs(line)
            if meta.get('URI'):
                map_range, previous_range_end = byte_range(
                    meta.get('BYTERANGE'),
                    previous_range_end,
                )
                init = {
                    'url': urljoin(url, meta['URI']),
                    'range': map_range,
                }
        elif line.startswith('#EXT-X-KEY:'):
            meta = attrs(line)
            method = meta.get('METHOD')
            if method in (None, 'NONE'):
                key = None
            else:
                key = {
                    'method': method,
                    'url': urljoin(url, meta.get('URI', '')),
                    'iv': meta.get('IV'),
                }
        elif line.startswith('#EXT-X-BYTERANGE:'):
            pending_range = line.split(':', 1)[1]
        elif line and not line.startswith('#'):
            range_header, previous_range_end = byte_range(
                pending_range,
                previous_range_end,
            )
            segments.append({
                'url': urljoin(url, line),
                'range': range_header,
                'seq': sequence + len(segments),
                'key': dict(key) if key else None,
            })
            pending_range = None

    if not segments:
        raise RuntimeError('no HLS segments')
    return init, segments


def iv_bytes(raw, seq):
    if raw:
        return bytes.fromhex(raw.lower().removeprefix('0x').rjust(32, '0')[-32:])
    return int(seq).to_bytes(16, 'big')


def decrypt_segment(data, keyinfo, key_cache, key_lock, seq):
    if not keyinfo:
        return data
    if keyinfo.get('method') != 'AES-128':
        raise RuntimeError('unsupported encryption')
    key_url = keyinfo.get('url')
    if not key_url or not allowed(key_url):
        raise RuntimeError('invalid HLS key')
    with key_lock:
        key = key_cache.get(key_url)
    if key is None:
        key = fetch_bytes(key_url)
        with key_lock:
            key_cache[key_url] = key

    decryptor = Cipher(
        algorithms.AES(key),
        modes.CBC(iv_bytes(keyinfo.get('iv'), seq)),
    ).decryptor()
    raw = decryptor.update(data) + decryptor.finalize()
    try:
        unpadder = PKCS7(128).unpadder()
        return unpadder.update(raw) + unpadder.finalize()
    except Exception:
        return raw


def safe_name(value):
    value = re.sub(r'[\\/:*?"<>|\r\n]+', '_', value or 'video').strip()[:100]
    return value or 'video'


def wait_future(future, cancel_event):
    while not cancel_event.is_set():
        try:
            return future.result(timeout=0.25)
        except FutureTimeout:
            continue
    raise RuntimeError('download cancelled')


def adaptive_worker_count(segment_count, first_fetch_seconds, max_workers=None):
    """Choose HLS prefetch concurrency from the first real segment latency."""
    remaining = max(0, int(segment_count) - 1)
    if remaining <= 0:
        return 1
    ceiling = max(1, min(int(max_workers or DOWNLOAD_WORKERS), remaining))
    if remaining <= 3:
        return min(2, ceiling)
    latency = max(0.0, float(first_fetch_seconds))
    if latency <= 0.35:
        target = 8
    elif latency <= 0.8:
        target = 6
    elif latency <= 1.5:
        target = 4
    else:
        target = 2
    if remaining < 12:
        target = min(target, 4)
    return max(1, min(target, ceiling))


def detect_input_format(init_bytes, first_bytes):
    head = (init_bytes[:128] if init_bytes else b'') + first_bytes[:4096]
    if b'ftyp' in head[:128] or b'moov' in head[:4096] or b'moof' in head[:4096]:
        return 'mp4'
    if first_bytes[:1] == b'\x47':
        if len(first_bytes) < 188 * 3:
            return 'mpegts'
        if first_bytes[188:189] == b'\x47' and first_bytes[376:377] == b'\x47':
            return 'mpegts'
    return None


def download_headers(title, quality):
    filename = f'{safe_name(title)}-{safe_name(quality)}.mp4'
    encoded_name = quote(filename, safe='')
    return {
        'Content-Disposition': f"attachment; filename=\"video.mp4\"; filename*=UTF-8''{encoded_name}",
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'X-Accel-Buffering': 'no',
        'Accept-Ranges': 'none',
    }


class ManagedStream:
    def __init__(self, iterator, cleanup):
        self.iterator = iterator
        self.cleanup = cleanup

    def __iter__(self):
        return self

    def __next__(self):
        return next(self.iterator)

    def close(self):
        self.cleanup()


class NativeStreamingResponse(StreamingResponse):
    def __init__(self, body, **kwargs):
        super().__init__(body, **kwargs)
        self.native_body = body
        self.cleanup_lock = threading.Lock()
        self.cleaned = False

    def close(self):
        with self.cleanup_lock:
            if self.cleaned:
                return
            self.cleaned = True
            try:
                self.native_body.close()
            finally:
                DOWNLOAD_SLOTS.release()

    async def cleanup(self):
        with anyio.CancelScope(shield=True):
            await run_in_threadpool(self.close)

    async def listen_for_disconnect(self, receive):
        await super().listen_for_disconnect(receive)
        await self.cleanup()

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self.cleanup()


def prepare_mp4_stream(stream_url, on_progress=None):
    init, segments = load_playlist(stream_url)
    key_cache = {}
    key_lock = threading.Lock()
    cancel_event = threading.Event()
    feed_error = []

    init_bytes = b''
    if init:
        init_bytes = fetch_bytes(init['url'], init.get('range'))

    first = segments[0]
    first_fetch_started = time.monotonic()
    first_bytes = fetch_bytes(first['url'], first.get('range'))
    first_fetch_seconds = max(0.001, time.monotonic() - first_fetch_started)
    first_bytes = decrypt_segment(
        first_bytes,
        first.get('key'),
        key_cache,
        key_lock,
        first['seq'],
    )
    selected_workers = adaptive_worker_count(len(segments), first_fetch_seconds)

    input_format = detect_input_format(init_bytes, first_bytes)
    print(
        f'NATIVE_INPUT format={input_format or "auto"} init={len(init_bytes)} first={len(first_bytes)} '
        f'workers={selected_workers}/{DOWNLOAD_WORKERS} firstFetchMs={round(first_fetch_seconds * 1000)} '
        f'head={(init_bytes or first_bytes)[:16].hex()}',
        flush=True,
    )

    command = [
        'ffmpeg',
        '-hide_banner',
        '-loglevel', 'error',
        '-fflags', '+genpts+discardcorrupt',
        '-probesize', '50000000',
        '-analyzeduration', '50000000',
    ]
    if input_format:
        command.extend(['-f', input_format])
    command.extend([
        '-i', 'pipe:0',
        '-map', '0:v?',
        '-map', '0:a?',
        '-c', 'copy',
    ])
    if input_format == 'mpegts':
        command.extend(['-bsf:a', 'aac_adtstoasc'])
    command.extend([
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4',
        'pipe:1',
    ])

    proc = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )

    stderr_tail = bytearray()

    def drain_stderr():
        try:
            while True:
                chunk = proc.stderr.read(8192)
                if not chunk:
                    break
                stderr_tail.extend(chunk)
                del stderr_tail[:-8192]
        except (OSError, ValueError):
            pass

    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()

    stop_lock = threading.Lock()
    stopped = False

    def stop_process():
        nonlocal stopped
        with stop_lock:
            if stopped:
                return
            stopped = True
            cancel_event.set()
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=3)
            feeder_thread.join(timeout=3 * UPSTREAM_TIMEOUT + 5)
            stderr_thread.join(timeout=1.0)
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                if not pipe.closed:
                    pipe.close()

    def read_output(timeout):
        ready, _, _ = select.select([proc.stdout], [], [], timeout)
        if not ready:
            raise RuntimeError('ffmpeg MP4 output stalled')
        return os.read(proc.stdout.fileno(), 256 * 1024)

    def feeder():
        pool = None
        try:
            if init_bytes and not cancel_event.is_set():
                proc.stdin.write(init_bytes)
            if not cancel_event.is_set():
                proc.stdin.write(first_bytes)
                if on_progress:
                    on_progress(1, len(segments))

            start = 1
            remaining = len(segments) - start
            if remaining <= 0:
                return

            workers = max(1, min(selected_workers, remaining))
            pool = ThreadPoolExecutor(max_workers=workers)
            futures = {}
            next_submit = start

            while next_submit < min(len(segments), start + workers):
                segment = segments[next_submit]
                futures[next_submit] = pool.submit(
                    fetch_bytes,
                    segment['url'],
                    segment.get('range'),
                )
                next_submit += 1

            next_emit = start
            while next_emit < len(segments) and not cancel_event.is_set():
                data = wait_future(futures.pop(next_emit), cancel_event)
                segment = segments[next_emit]
                data = decrypt_segment(
                    data,
                    segment.get('key'),
                    key_cache,
                    key_lock,
                    segment['seq'],
                )
                if cancel_event.is_set():
                    break
                proc.stdin.write(data)
                if on_progress:
                    on_progress(next_emit + 1, len(segments))

                if next_submit < len(segments):
                    segment = segments[next_submit]
                    futures[next_submit] = pool.submit(
                        fetch_bytes,
                        segment['url'],
                        segment.get('range'),
                    )
                    next_submit += 1
                next_emit += 1
        except Exception as exc:
            if not cancel_event.is_set():
                feed_error.append(exc)
            cancel_event.set()
            try:
                proc.kill()
            except Exception:
                pass
        finally:
            if pool is not None:
                pool.shutdown(wait=True, cancel_futures=True)
            try:
                proc.stdin.close()
            except Exception:
                pass

    feeder_thread = threading.Thread(target=feeder, daemon=True)
    feeder_thread.start()

    try:
        first_output = read_output(FIRST_OUTPUT_TIMEOUT)
    except Exception:
        stop_process()
        raise
    if not first_output:
        stop_process()
        return_code = proc.returncode
        message = bytes(stderr_tail).decode('utf-8', 'replace')[-1000:]
        if feed_error:
            message = f'{message} feeder={feed_error[0]!r}'.strip()
        print(f'NATIVE_PREPARE_FAILED rc={return_code} {message}', flush=True)
        raise RuntimeError(f'ffmpeg could not create MP4: {message[-300:]}')

    print(f'NATIVE_DOWNLOAD_READY first_output={len(first_output)}', flush=True)

    def iterator():
        try:
            yield first_output
            while True:
                chunk = read_output(OUTPUT_IDLE_TIMEOUT)
                if not chunk:
                    break
                yield chunk
            return_code = proc.wait(timeout=3)
            feeder_thread.join(timeout=1.5)
            stderr_thread.join(timeout=1.0)
            if cancel_event.is_set() and not feed_error:
                return
            if feed_error or return_code != 0:
                message = bytes(stderr_tail).decode('utf-8', 'replace')[-1000:]
                print(
                    f'NATIVE_STREAM_FAILED rc={return_code} feeder={feed_error[0] if feed_error else ""} {message}',
                    flush=True,
                )
                if feed_error:
                    raise feed_error[0]
                raise RuntimeError(f'ffmpeg failed: {message[-300:]}')
            print('NATIVE_DOWNLOAD_COMPLETE', flush=True)
        finally:
            stop_process()

    return ManagedStream(iterator(), stop_process), input_format


@app.get('/health')
def health():
    return {
        'ok': True,
        'mode': 'native-mobile-stream-v5-files',
        'downloadWorkers': DOWNLOAD_WORKERS,
        'adaptiveDownloadWorkers': True,
        'maxActiveDownloads': MAX_ACTIVE_DOWNLOADS,
        'fileStorageFreeBytes': __import__('shutil').disk_usage(file_jobs.root).free,
        'fileStorageReserveBytes': file_jobs.FREE_RESERVE,
    }


@app.head('/download')
def download_head(
    stream_url: str = Query(..., min_length=1),
    title: str = Query('video'),
    quality: str = Query('video'),
):
    if not allowed(stream_url):
        raise HTTPException(400, 'unsupported stream host')
    response = Response(
        status_code=200,
        media_type='video/mp4',
        headers=download_headers(title, quality),
    )
    if 'content-length' in response.headers:
        del response.headers['content-length']
    return response


@app.get('/download')
def download(
    stream_url: str = Query(..., min_length=1),
    title: str = Query('video'),
    quality: str = Query('video'),
):
    if not allowed(stream_url):
        raise HTTPException(400, 'unsupported stream host')

    if not DOWNLOAD_SLOTS.acquire(blocking=False):
        raise HTTPException(503, '다운로드가 진행 중입니다. 잠시 후 다시 시도하세요.',
                            headers={'Retry-After': '5'})
    print('NATIVE_DOWNLOAD_START', flush=True)
    try:
        body, input_format = prepare_mp4_stream(stream_url)
    except Exception as exc:
        DOWNLOAD_SLOTS.release()
        print(f'NATIVE_DOWNLOAD_REJECTED {exc!r}', flush=True)
        raise HTTPException(502, 'MP4 변환을 시작하지 못했습니다. 다시 시도하세요.') from exc

    print(f'NATIVE_DOWNLOAD_HANDOFF format={input_format or "auto"}', flush=True)
    return NativeStreamingResponse(
        body,
        media_type='video/mp4',
        headers=download_headers(title, quality),
    )


from file_jobs import install_file_jobs
file_jobs = install_file_jobs(app, allowed, prepare_mp4_stream, DOWNLOAD_SLOTS, safe_name)
