import unittest
from unittest.mock import patch

import retry_transport


class RetryTransportTests(unittest.TestCase):
    def test_retries_transient_timeout_for_media_host(self):
        calls = []

        def fake_get(url, *args, **kwargs):
            calls.append(url)
            if len(calls) < 3:
                raise TimeoutError('curl: (28) Operation timed out')
            return object()

        with patch.object(retry_transport, '_original_get', fake_get), \
             patch.object(retry_transport, 'SESSION_REUSE', False), \
             patch.object(retry_transport, 'MAX_ATTEMPTS', 3), \
             patch.object(retry_transport, 'BACKOFF_SECONDS', 0), \
             patch.object(retry_transport, 'SLOW_REQUEST_SECONDS', 0):
            result = retry_transport.retrying_get('https://surrit.com/a/seg.ts')

        self.assertIsNotNone(result)
        self.assertEqual(len(calls), 3)

    def test_does_not_retry_unrelated_host(self):
        calls = []

        def fake_get(url, *args, **kwargs):
            calls.append(url)
            raise TimeoutError('curl: (28) Operation timed out')

        with patch.object(retry_transport, '_original_get', fake_get), \
             patch.object(retry_transport, 'MAX_ATTEMPTS', 3), \
             patch.object(retry_transport, 'BACKOFF_SECONDS', 0):
            with self.assertRaises(TimeoutError):
                retry_transport.retrying_get('https://example.com/a/seg.ts')

        self.assertEqual(len(calls), 1)

    def test_does_not_retry_non_transient_error(self):
        calls = []

        def fake_get(url, *args, **kwargs):
            calls.append(url)
            raise RuntimeError('bad request')

        with patch.object(retry_transport, '_original_get', fake_get), \
             patch.object(retry_transport, 'SESSION_REUSE', False), \
             patch.object(retry_transport, 'MAX_ATTEMPTS', 3), \
             patch.object(retry_transport, 'BACKOFF_SECONDS', 0):
            with self.assertRaises(RuntimeError):
                retry_transport.retrying_get('https://nineyu.com/a/seg.ts')

        self.assertEqual(len(calls), 1)

    def test_media_request_drops_forced_revalidation_but_keeps_range(self):
        captured = []

        def fake_get(url, *args, **kwargs):
            captured.append(kwargs)
            return object()

        with patch.object(retry_transport, '_original_get', fake_get), \
             patch.object(retry_transport, 'SESSION_REUSE', False), \
             patch.object(retry_transport, 'STRIP_REVALIDATION', True), \
             patch.object(retry_transport, 'MAX_ATTEMPTS', 1), \
             patch.object(retry_transport, 'SLOW_REQUEST_SECONDS', 0):
            retry_transport.retrying_get(
                'https://surrit.com/a/seg.ts',
                headers={
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Range': 'bytes=100-199',
                },
                impersonate='chrome',
            )

        headers = captured[0]['headers']
        self.assertNotIn('Cache-Control', headers)
        self.assertNotIn('Pragma', headers)
        self.assertEqual(headers['Range'], 'bytes=100-199')
        self.assertEqual(captured[0]['impersonate'], 'chrome')

    def test_media_request_uses_persistent_thread_session(self):
        class FakeSession:
            def __init__(self):
                self.calls = []

            def get(self, url, *args, **kwargs):
                self.calls.append((url, kwargs))
                return object()

        session = FakeSession()
        with patch.object(retry_transport, '_session_for_thread', return_value=session), \
             patch.object(retry_transport, 'SESSION_REUSE', True), \
             patch.object(retry_transport, 'STRIP_REVALIDATION', True), \
             patch.object(retry_transport, 'MAX_ATTEMPTS', 1), \
             patch.object(retry_transport, 'SLOW_REQUEST_SECONDS', 0):
            retry_transport.retrying_get(
                'https://cdn.nineyu.com/a/seg.ts',
                headers={'Cache-Control': 'no-cache'},
                impersonate='chrome',
                timeout=15,
            )
            retry_transport.retrying_get(
                'https://cdn.nineyu.com/a/seg2.ts',
                headers={'Cache-Control': 'no-cache'},
                impersonate='chrome',
                timeout=15,
            )

        self.assertEqual(len(session.calls), 2)
        for _, kwargs in session.calls:
            self.assertNotIn('impersonate', kwargs)
            self.assertNotIn('Cache-Control', kwargs['headers'])
            self.assertEqual(kwargs['timeout'], 15)

    def test_timeout_resets_keepalive_session_before_retry(self):
        class FlakySession:
            def __init__(self):
                self.calls = 0

            def get(self, url, *args, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    raise TimeoutError('curl: (28) Operation timed out')
                return object()

        session = FlakySession()
        resets = []
        with patch.object(retry_transport, '_session_for_thread', return_value=session), \
             patch.object(retry_transport, '_reset_thread_session', side_effect=lambda: resets.append(1)), \
             patch.object(retry_transport, 'SESSION_REUSE', True), \
             patch.object(retry_transport, 'MAX_ATTEMPTS', 2), \
             patch.object(retry_transport, 'BACKOFF_SECONDS', 0), \
             patch.object(retry_transport, 'SLOW_REQUEST_SECONDS', 0):
            result = retry_transport.retrying_get('https://surrit.com/a/seg.ts')

        self.assertIsNotNone(result)
        self.assertEqual(session.calls, 2)
        self.assertEqual(len(resets), 1)


if __name__ == '__main__':
    unittest.main()
