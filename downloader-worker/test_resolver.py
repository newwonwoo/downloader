import unittest
from unittest.mock import patch

import resolver


class ResolverTests(unittest.TestCase):
    def test_accepts_only_njav_source(self):
        self.assertEqual(
            resolver.valid_source('https://njavtv.com/dm890/ko/example'),
            'https://njavtv.com/dm890/ko/example',
        )
        self.assertIsNone(resolver.valid_source('https://example.com/video'))

    def test_extracts_uuid_and_generic_quality_candidates(self):
        video_id = '12345678-1234-1234-1234-123456789abc'
        html = f'<script>const player={{videoId:"{video_id}"}}</script>'
        found_id, urls = resolver.candidates(html, 'https://njavtv.com/dm890/ko/example')
        self.assertEqual(found_id, video_id)
        self.assertIn(f'https://surrit.com/{video_id}/1280x720/video.m3u8', urls)
        self.assertIn(f'https://surrit.com/{video_id}/640x360/video.m3u8', urls)

    def test_prefers_direct_manifest_found_in_page(self):
        video_id = '12345678-1234-1234-1234-123456789abc'
        direct = f'https://surrit.com/{video_id}/842x480/video.m3u8'
        found_id, urls = resolver.candidates(f'<source src="{direct}">', 'https://njavtv.com/x')
        self.assertEqual(found_id, video_id)
        self.assertEqual(urls[0], direct)

    def test_verified_target_does_not_refetch_blocked_source_page(self):
        page_url = 'https://njavtv.com/dm890/ko/102816-005'
        with patch.object(resolver, 'fetch', side_effect=AssertionError('verified target must not refetch source')):
            result = resolver.resolve(page_url)
        self.assertTrue(result['ok'])
        self.assertEqual(result['resolver'], 'render-verified-target-v1')
        self.assertEqual(result['videoId'], 'fee1f896-c34b-4caa-a712-0e8241e38cfc')
        self.assertEqual(
            [stream['quality'] for stream in result['streams']],
            ['1280x720', '842x480', '640x360'],
        )


if __name__ == '__main__':
    unittest.main()
