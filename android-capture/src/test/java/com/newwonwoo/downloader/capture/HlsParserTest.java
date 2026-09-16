package com.newwonwoo.downloader.capture;

import static org.junit.Assert.*;

import org.junit.Test;

public class HlsParserTest {
    @Test
    public void parsesTransportStreamPlaylist() throws Exception {
        String text = "#EXTM3U\n"
                + "#EXT-X-MEDIA-SEQUENCE:7\n"
                + "#EXTINF:4,\nseg-a.ts\n"
                + "#EXTINF:4,\nseg-b.ts\n";
        HlsDownloadService.Playlist playlist = HlsDownloadService.parseMediaPlaylist(
                "https://cdn.example.net/v/index.m3u8", text);
        assertNull(playlist.initMap());
        assertEquals(2, playlist.segments().size());
        assertEquals(7, playlist.segments().get(0).sequence());
        assertEquals("https://cdn.example.net/v/seg-b.ts", playlist.segments().get(1).url());
    }

    @Test
    public void parsesFragmentedMp4Playlist() throws Exception {
        String text = "#EXTM3U\n"
                + "#EXT-X-MAP:URI=\"init.mp4\"\n"
                + "#EXTINF:4,\npart-1.m4s\n"
                + "#EXTINF:4,\npart-2.m4s\n";
        HlsDownloadService.Playlist playlist = HlsDownloadService.parseMediaPlaylist(
                "https://media.othercdn.com/hls/index.m3u8", text);
        assertNotNull(playlist.initMap());
        assertEquals("https://media.othercdn.com/hls/init.mp4", playlist.initMap().url());
        assertEquals(2, playlist.segments().size());
    }

    @Test
    public void acceptsUnknownExternalCdn() {
        assertTrue(HlsDownloadService.safeExternalHttps("https://new-cdn.example.org/seg.ts"));
    }
}
