import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from starlette.requests import ClientDisconnect


spec = importlib.util.spec_from_file_location(
    'worker', os.environ.get('WORKER_MODULE', str(Path(__file__).with_name('app.py')))
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
REAL_POPEN = subprocess.Popen


class StreamLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.processes = []
        self.addCleanup(self.cleanup_processes)
        self.enterContext(patch.object(worker, 'FIRST_OUTPUT_TIMEOUT', 2))
        self.enterContext(patch.object(worker, 'OUTPUT_IDLE_TIMEOUT', 1, create=True))
        self.enterContext(patch.object(worker, 'load_playlist', return_value=(None, [
            {'url': 'https://surrit.com/test.ts', 'range': None, 'key': None, 'seq': 0}
        ])))
        self.enterContext(patch.object(worker, 'fetch_bytes', return_value=b'\x47' * 564))

    def cleanup_processes(self):
        for proc in self.processes:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=3)
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                if pipe and not pipe.closed:
                    pipe.close()

    def fake_ffmpeg(self, script):
        def spawn(command, **kwargs):
            proc = REAL_POPEN([sys.executable, '-c', script], **kwargs)
            self.processes.append(proc)
            return proc
        self.enterContext(patch.object(worker.subprocess, 'Popen', side_effect=spawn))

    def test_large_error_log_does_not_block_media(self):
        self.fake_ffmpeg(
            "import os; os.write(2, b'error\\n' * 100000); "
            "os.write(1, b'ftyp-media'); os.read(0, 4096)"
        )
        body, _ = worker.prepare_mp4_stream('fixture')
        self.assertEqual(b''.join(body), b'ftyp-media')
        self.assertEqual(self.processes[0].returncode, 0)

    def test_stdout_eof_allows_normal_exit(self):
        self.fake_ffmpeg(
            "import os,time; os.read(0,4096); os.write(1,b'media'); "
            "os.close(1); time.sleep(0.3)"
        )
        body, _ = worker.prepare_mp4_stream('fixture')
        self.assertEqual(b''.join(body), b'media')
        self.assertEqual(self.processes[0].returncode, 0)

    def test_stalled_stream_fails_and_reaps_process(self):
        self.fake_ffmpeg(
            "import os,time; os.write(1,b'media'); time.sleep(30)"
        )
        body, _ = worker.prepare_mp4_stream('fixture')
        self.assertEqual(next(body), b'media')
        with self.assertRaisesRegex(RuntimeError, 'stalled'):
            next(body)
        self.assertIsNotNone(self.processes[0].poll())

    def test_client_disconnect_reaps_process(self):
        self.fake_ffmpeg(
            "import os,time; os.write(1,b'media'); time.sleep(30)"
        )
        body, _ = worker.prepare_mp4_stream('fixture')
        next(body)
        body.close()
        self.assertIsNotNone(self.processes[0].poll())

    def test_disconnect_before_first_body_reaps_and_releases_slot(self):
        self.fake_ffmpeg("import os,time; os.write(1,b'media'); time.sleep(30)")
        slots = threading.BoundedSemaphore(1)
        with patch.object(worker, 'DOWNLOAD_SLOTS', slots):
            response = worker.download('https://surrit.com/test.m3u8', 'test', '360')

            async def send(message):
                raise OSError('client disconnected before body')

            async def receive():
                return {'type': 'http.disconnect'}

            async def run():
                try:
                    await response({'type': 'http', 'asgi': {'spec_version': '2.4'}}, receive, send)
                except (OSError, ClientDisconnect):
                    pass

            worker.anyio.run(run)
            self.assertIsNotNone(self.processes[0].poll())
            self.assertTrue(slots.acquire(blocking=False))
            response.close()
            self.assertFalse(slots.acquire(blocking=False))
            slots.release()

    def test_busy_server_does_not_start_another_converter(self):
        slots = threading.BoundedSemaphore(1)
        slots.acquire()
        with patch.object(worker, 'DOWNLOAD_SLOTS', slots), patch.object(worker, 'prepare_mp4_stream') as prepare:
            with self.assertRaises(worker.HTTPException) as caught:
                worker.download('https://surrit.com/test.m3u8', 'test', '360')
            self.assertEqual(caught.exception.status_code, 503)
            prepare.assert_not_called()

    def test_prepare_failure_releases_capacity(self):
        slots = threading.BoundedSemaphore(1)
        with patch.object(worker, 'DOWNLOAD_SLOTS', slots), patch.object(worker, 'prepare_mp4_stream', side_effect=RuntimeError('upstream')):
            with self.assertRaises(worker.HTTPException) as caught:
                worker.download('https://surrit.com/test.m3u8', 'test', '360')
            self.assertEqual(caught.exception.status_code, 502)
            self.assertTrue(slots.acquire(blocking=False))
            slots.release()

    def test_real_ffmpeg_complete_video(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'source.ts'
            result = Path(tmp) / 'result.mp4'
            subprocess.run([
                'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                'testsrc=size=160x120:rate=10', '-t', '2', '-c:v', 'mpeg2video',
                '-f', 'mpegts', str(source)
            ], check=True, timeout=15)
            with patch.object(worker, 'fetch_bytes', return_value=source.read_bytes()):
                body, fmt = worker.prepare_mp4_stream('fixture')
                result.write_bytes(b''.join(body))
            self.assertEqual(fmt, 'mpegts')
            subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(result),
                            '-f', 'null', '-'], check=True, timeout=15)
            self.assertGreater(result.stat().st_size, 1000)


if __name__ == '__main__':
    unittest.main()
