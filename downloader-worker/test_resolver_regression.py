import unittest
from types import SimpleNamespace
from unittest.mock import patch

import resolver


class ResolverFallbackRegressionTests(unittest.TestCase):
    def test_fetch_prefers_last_http_response_over_later_dns_error(self):
        blocked = SimpleNamespace(status_code=403, text='Just a moment', url='https://njavtv.com/x')
        dns_error = RuntimeError('Could not resolve host: www.njavtv.com')
        with patch.object(resolver, '_session_fetch', side_effect=[blocked, blocked, dns_error, dns_error]):
            result = resolver.fetch('https://njavtv.com/dm2/ko/example', timeout=1)
        self.assertIs(result, blocked)

    def test_resolve_turns_blocked_source_into_409_not_server_error(self):
        blocked = SimpleNamespace(status_code=403, text='Just a moment', url='https://njavtv.com/x')
        with patch.object(resolver, 'fetch', return_value=blocked):
            with self.assertRaises(resolver.HTTPException) as caught:
                resolver.resolve('https://njavtv.com/dm2/ko/example')
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail['code'], 'SOURCE_BLOCKED')


if __name__ == '__main__':
    unittest.main()
