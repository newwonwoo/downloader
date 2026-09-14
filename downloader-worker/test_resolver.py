import unittest

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


if __name__ == '__main__':
    unittest.main()
