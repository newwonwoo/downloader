"""Prepare complete, bounded temporary files before native HTTP downloads."""
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import threading
import time

from fastapi import HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field


class PrepareRequest(BaseModel):
    stream_url: str = Field(min_length=1, max_length=8192)
    title: str = Field(default='video', max_length=500)
    quality: str = Field(default='video', max_length=40)
    request_key: str = Field(min_length=16, max_length=100)


class FileJobs:
    TTL = 3600
    MAX_JOBS = 3
    MAX_BYTES = int(os.getenv('MAX_FILE_BYTES', str(16 * 1024**3)))
    FREE_RESERVE = 256 * 1024**2

    def __init__(self, allowed, prepare, slots, safe_name, root=None):
        self.allowed, self.prepare, self.slots, self.safe_name = allowed, prepare, slots, safe_name
        self.root = Path(root or tempfile.mkdtemp(prefix='downloader-files-'))
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.jobs = {}
        self.preparing = False

    def expire(self):
        with self.lock:
            now = time.time()
            for job_id, job in list(self.jobs.items()):
                if job['status'] == 'preparing' or job['readers']:
                    continue
                if now - job['touched'] < self.TTL:
                    continue
                for suffix in ('.part', '.mp4'):
                    (self.root / (job_id + suffix)).unlink(missing_ok=True)
                del self.jobs[job_id]

    def snapshot(self, job):
        return {key: job[key] for key in (
            'id', 'status', 'title', 'quality', 'bytes', 'completedSegments',
            'totalSegments', 'message', 'sha256'
        )} | {'file_url': f"/files/{job['id']}.mp4" if job['status'] == 'ready' else None,
             'expiresInSeconds': self.TTL}

    def create(self, data):
        if not self.allowed(data.stream_url):
            raise HTTPException(400, '지원하지 않는 영상 주소입니다.')
        self.expire()
        with self.lock:
            for job in self.jobs.values():
                if job['request_key'] == data.request_key:
                    if job['stream_url'] != data.stream_url:
                        raise HTTPException(409, '요청 키가 다른 영상에 사용됐습니다.')
                    job['touched'] = time.time()
                    return self.snapshot(job)
            for old_id, old in list(self.jobs.items()):
                if old['status'] == 'failed':
                    del self.jobs[old_id]
            if self.preparing or len(self.jobs) >= self.MAX_JOBS:
                raise HTTPException(503, '서버가 다른 파일을 준비 중이거나 임시 보관함이 가득 찼습니다. 잠시 후 다시 시도하세요.',
                                    headers={'Retry-After': '10'})
            if shutil.disk_usage(self.root).free < self.FREE_RESERVE * 2:
                raise HTTPException(507, '파일 준비에 필요한 임시 공간이 부족합니다.')
            if not self.slots.acquire(blocking=False):
                raise HTTPException(503, '기존 다운로드 작업이 정리 중입니다. 잠시 후 다시 시도하세요.',
                                    headers={'Retry-After': '10'})
            job_id = secrets.token_urlsafe(24)
            job = dict(id=job_id, request_key=data.request_key, stream_url=data.stream_url,
                       title=self.safe_name(data.title), quality=self.safe_name(data.quality),
                       status='preparing', bytes=0, completedSegments=0, totalSegments=0,
                       message='영상 목록 확인 중', sha256=None, readers=0, touched=time.time(),
                       limit=min(self.MAX_BYTES, shutil.disk_usage(self.root).free - self.FREE_RESERVE))
            self.jobs[job_id] = job
            self.preparing = True
            try:
                thread = threading.Thread(target=self.build, args=(job_id,), daemon=True)
                thread.start()
            except Exception:
                self.preparing = False
                del self.jobs[job_id]
                self.slots.release()
                raise
            return self.snapshot(job)

    def build(self, job_id):
        part = self.root / (job_id + '.part')
        body = None
        started = time.monotonic()
        job = self.jobs[job_id]
        digest = hashlib.sha256()
        def progress(done, total):
            with self.lock:
                job.update(completedSegments=done, totalSegments=total, message='MP4 파일 준비 중')
        try:
            body, _ = self.prepare(job['stream_url'], on_progress=progress)
            with part.open('wb') as output:
                for chunk in body:
                    if time.monotonic() - started > 3600:
                        raise RuntimeError('파일 준비 제한 시간(1시간)을 초과했습니다.')
                    if output.tell() + len(chunk) > job['limit']:
                        raise RuntimeError('영상이 서버의 현재 임시 저장 가능 용량을 초과했습니다.')
                    if shutil.disk_usage(self.root).free < self.FREE_RESERVE:
                        raise RuntimeError('파일 준비 중 임시 공간이 부족해졌습니다.')
                    output.write(chunk)
                    digest.update(chunk)
                    with self.lock:
                        job['bytes'] = output.tell()
            with part.open('rb') as check:
                header = check.read(128)
            if job['bytes'] < 32 or b'ftyp' not in header:
                raise RuntimeError('완성된 MP4 파일을 확인하지 못했습니다.')
            final = part.with_suffix('.mp4')
            os.replace(part, final)
            with self.lock:
                job.update(status='ready', sha256=digest.hexdigest(), touched=time.time(),
                           message='파일 준비 완료 · 휴대폰에 저장을 누르세요')
            print(f"FILE_JOB_READY id={job_id} bytes={job['bytes']} sha256={job['sha256']}", flush=True)
        except Exception as exc:
            part.unlink(missing_ok=True)
            with self.lock:
                job.update(status='failed', message=str(exc)[:300], touched=time.time())
            print(f'FILE_JOB_FAILED id={job_id} error={exc!r}', flush=True)
        finally:
            try:
                if body is not None:
                    body.close()
            finally:
                with self.lock:
                    self.preparing = False
                    self.slots.release()

    def status(self, job_id):
        self.expire()
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                raise HTTPException(410, '임시 파일이 만료됐거나 서버가 재시작됐습니다. 파일을 다시 준비하세요.')
            return self.snapshot(job)

    def file(self, job_id):
        self.expire()
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                raise HTTPException(410, '파일이 만료됐습니다. 파일을 다시 준비하세요.')
            if job['status'] != 'ready':
                raise HTTPException(409, '아직 파일 준비가 끝나지 않았습니다.')
            path = self.root / (job_id + '.mp4')
            if not path.is_file():
                raise HTTPException(410, '임시 파일이 없어졌습니다. 파일을 다시 준비하세요.')
            job['readers'] += 1
            job['touched'] = time.time()
            store = self
            class DownloadFile(FileResponse):
                async def __call__(self, scope, receive, send):
                    try:
                        await super().__call__(scope, receive, send)
                    finally:
                        with store.lock:
                            job['readers'] -= 1
                            job['touched'] = time.time()
            return DownloadFile(path, media_type='video/mp4',
                filename=f"{job['title']}-{job['quality']}.mp4",
                stat_result=path.stat(), headers={'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff', 'X-File-SHA256': job['sha256']})


def install_file_jobs(app, allowed, prepare, slots, safe_name):
    from resolver import install_resolver
    install_resolver(app)
    store = FileJobs(allowed, prepare, slots, safe_name)
    @app.post('/jobs', status_code=202)
    def create_file_job(data: PrepareRequest):
        return store.create(data)
    @app.get('/jobs/{job_id}')
    def get_file_job(job_id: str):
        return store.status(job_id)
    @app.api_route('/files/{job_id}.mp4', methods=['GET', 'HEAD'])
    def download_file(job_id: str):
        return store.file(job_id)
    def sweep():
        while True:
            threading.Event().wait(60)
            store.expire()
    threading.Thread(target=sweep, daemon=True).start()
    return store
