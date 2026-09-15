import hashlib
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from collections import namedtuple
from fastapi import FastAPI
from fastapi.testclient import TestClient
from file_jobs import install_file_jobs

PAYLOAD = b'\x00\x00\x00\x20ftypisom' + bytes(range(256)) * 1024


class FileJobTests(unittest.TestCase):
    def setUp(self):
        self.gate = threading.Event()
        self.calls = 0
        self.source_failure = False

        def prepare(url, on_progress):
            self.calls += 1
            def body():
                yield PAYLOAD[:1024]
                self.gate.wait(3)
                if self.source_failure:
                    raise RuntimeError('source interrupted')
                on_progress(2, 2)
                yield PAYLOAD[1024:]
            return body(), 'fixture'

        app = FastAPI()
        self.slots = threading.BoundedSemaphore(2)
        self.store = install_file_jobs(
            app,
            lambda url: url == 'https://fixture.test/video',
            prepare,
            self.slots,
            lambda name: name,
        )
        self.store.MAX_CONCURRENT_JOBS = 1
        self.store.MAX_QUEUED_JOBS = 2
        self.client = TestClient(app)
        self.request = dict(
            stream_url='https://fixture.test/video',
            title='test',
            quality='360',
            request_key='unique-request-key-1',
        )

    def tearDown(self):
        self.gate.set()
        deadline = time.monotonic() + 4
        while self.store.preparing and time.monotonic() < deadline:
            time.sleep(.01)
        import shutil
        shutil.rmtree(self.store.root, ignore_errors=True)
        self.client.close()

    def create_response(self, request=None):
        return self.client.post('/jobs', json=request or self.request)

    def create(self, request=None):
        response = self.create_response(request)
        self.assertEqual(response.status_code, 202, response.text)
        return response.json()['id']

    def wait_status(self, job_id, statuses, timeout=4):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            response = self.client.get('/jobs/' + job_id)
            if response.status_code == 200:
                result = response.json()
                if result['status'] in statuses:
                    return result
            time.sleep(.01)
        self.fail(f'job {job_id} did not reach {statuses}')

    def finish(self, job_id):
        self.gate.set()
        return self.wait_status(job_id, {'ready', 'failed'})

    def test_full_file_and_resume_match_sha256(self):
        job_id = self.create()
        self.assertIsNone(self.client.get('/jobs/' + job_id).json()['file_url'])
        self.assertEqual(self.client.get('/files/' + job_id + '.mp4').status_code, 409)
        job = self.finish(job_id)
        self.assertEqual(job['status'], 'ready')
        url = job['file_url']
        head = self.client.head(url)
        self.assertEqual(int(head.headers['content-length']), len(PAYLOAD))
        self.assertEqual(head.headers['accept-ranges'], 'bytes')
        self.assertEqual(head.content, b'')
        self.assertIn('attachment;', head.headers['content-disposition'])
        first = self.client.get(url, headers={'Range': 'bytes=0-8191'})
        rest = self.client.get(url, headers={'Range': 'bytes=8192-', 'If-Range': head.headers['etag']})
        self.assertEqual((first.status_code, rest.status_code), (206, 206))
        self.assertEqual(rest.headers['content-range'], f'bytes 8192-{len(PAYLOAD)-1}/{len(PAYLOAD)}')
        self.assertEqual(first.content + rest.content, PAYLOAD)
        self.assertEqual(hashlib.sha256(first.content + rest.content).hexdigest(), job['sha256'])
        self.assertEqual(self.client.get(url).content, PAYLOAD)
        self.assertEqual(self.client.get(url, headers={'Range': 'bytes=999999999-'}).status_code, 416)
        self.assertEqual(self.store.jobs[job_id]['readers'], 0)

    def test_retry_is_idempotent_and_contention_is_queued(self):
        first = self.create()
        self.assertEqual(self.create(), first)
        self.wait_status(first, {'preparing'})

        second_request = self.request | {'request_key': 'different-request-key-2'}
        third_request = self.request | {'request_key': 'different-request-key-3'}
        fourth_request = self.request | {'request_key': 'different-request-key-4'}
        second = self.create_response(second_request)
        third = self.create_response(third_request)
        fourth = self.create_response(fourth_request)

        self.assertEqual(second.status_code, 202, second.text)
        self.assertEqual(third.status_code, 202, third.text)
        self.assertEqual(second.json()['status'], 'queued')
        self.assertEqual(third.json()['status'], 'queued')
        self.assertEqual(second.json()['queuePosition'], 1)
        self.assertEqual(third.json()['queuePosition'], 2)
        self.assertEqual(fourth.status_code, 503)

        self.gate.set()
        for job_id in (first, second.json()['id'], third.json()['id']):
            self.assertEqual(self.finish(job_id)['status'], 'ready')
        self.assertEqual(self.calls, 3)

    def test_job_waits_in_queue_while_shared_download_slots_are_busy(self):
        self.assertTrue(self.slots.acquire(blocking=False))
        self.assertTrue(self.slots.acquire(blocking=False))
        try:
            job_id = self.create()
            queued = self.wait_status(job_id, {'queued'})
            self.assertEqual(queued['queuePosition'], 1)
            self.assertEqual(self.calls, 0)
        finally:
            self.slots.release()
            self.slots.release()
        self.store.dispatch_event.set()
        self.gate.set()
        self.assertEqual(self.finish(job_id)['status'], 'ready')
        self.assertEqual(self.calls, 1)

    def test_failure_never_exposes_partial_file(self):
        self.source_failure = True
        job_id = self.create()
        job = self.finish(job_id)
        self.assertEqual(job['status'], 'failed')
        self.assertIsNone(job['file_url'])
        self.assertEqual(list(self.store.root.iterdir()), [])
        self.assertEqual(self.client.get('/files/' + job_id + '.mp4').status_code, 409)

    def test_disk_limits_and_source_validation(self):
        usage = namedtuple('usage', 'total used free')(100, 99, 1)
        with patch('file_jobs.shutil.disk_usage', return_value=usage):
            self.assertEqual(self.client.post('/jobs', json=self.request).status_code, 507)
        self.assertEqual(self.calls, 0)
        self.assertEqual(self.client.post('/jobs', json=self.request | {'stream_url': 'https://evil.test'}).status_code, 400)
        self.store.MAX_BYTES = 100
        job_id = self.create()
        self.assertEqual(self.finish(job_id)['status'], 'failed')
        self.assertEqual(list(self.store.root.iterdir()), [])

    def test_large_stream_throttles_disk_usage_probes(self):
        chunk = b'\x00\x00\x00\x20ftypisom' + b'x' * (1024 - 12)
        self.store.DISK_CHECK_INTERVAL_BYTES = 4 * 1024
        self.store.BYTE_PROGRESS_INTERVAL = 4 * 1024
        self.gate.set()

        def prepare(url, on_progress):
            def body():
                for index in range(20):
                    on_progress(index + 1, 20)
                    yield chunk
            return body(), 'fixture'

        self.store.prepare = prepare
        usage = namedtuple('usage', 'total used free')(2**31, 0, 2**30)
        with patch('file_jobs.shutil.disk_usage', return_value=usage) as disk_usage:
            job_id = self.create()
            job = self.finish(job_id)
        self.assertEqual(job['status'], 'ready')
        self.assertEqual(job['bytes'], len(chunk) * 20)
        self.assertLessEqual(disk_usage.call_count, 7)

    def test_expiry_and_restart_are_explicit(self):
        job_id = self.create()
        job = self.finish(job_id)
        self.store.jobs[job_id]['touched'] = 0
        self.store.jobs[job_id]['readers'] = 1
        self.store.expire()
        self.assertTrue((self.store.root / (job_id + '.mp4')).exists())
        self.store.jobs[job_id]['readers'] = 0
        self.assertEqual(self.client.get('/jobs/' + job_id).status_code, 410)
        self.assertEqual(self.client.get(job['file_url']).status_code, 410)
        self.assertEqual(list(self.store.root.iterdir()), [])
        self.assertEqual(self.client.get('/jobs/unknown-after-restart').status_code, 410)


if __name__ == '__main__':
    unittest.main()
