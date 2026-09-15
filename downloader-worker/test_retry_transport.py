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
             patch.object(retry_transport, 'MAX_ATTEMPTS', 3), \
             patch.object(retry_transport, 'BACKOFF_SECONDS', 0):
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
             patch.object(retry_transport, 'MAX_ATTEMPTS', 3), \
             patch.object(retry_transport, 'BACKOFF_SECONDS', 0):
            with self.assertRaises(RuntimeError):
                retry_transport.retrying_get('https://nineyu.com/a/seg.ts')

        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
