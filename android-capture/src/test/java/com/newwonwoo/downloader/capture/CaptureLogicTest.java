package com.newwonwoo.downloader.capture;

import static org.junit.Assert.*;

import org.junit.Test;

public class CaptureLogicTest {
    @Test
    public void extractsReportedNjavUrl() {
        String url = "https://njavtv.com/ko/dvaj-041-uncensored-leak";
        assertEquals(url, CaptureActivity.extractSourceUrl(url));
        assertEquals(url, CaptureActivity.extractSourceUrl("공유됨 " + url + ")"));
    }

    @Test
    public void rejectsNonNjavSource() {
        assertNull(CaptureActivity.extractSourceUrl("https://example.com/video"));
        assertFalse(CaptureActivity.isAllowedSource("http://njavtv.com/ko/x"));
    }

    @Test
    public void acceptsExternalHttpsM3u8RegardlessOfCdnName() {
        assertEquals(
                "https://cdn.example.net/path/master.m3u8?token=1",
                CaptureActivity.safeMediaUrl("https://cdn.example.net/path/master.m3u8?token=1"));
        assertEquals(
                "https://surrit.com/a/1080p/index.m3u8",
                CaptureActivity.safeMediaUrl("https://surrit.com/a/1080p/index.m3u8"));
    }

    @Test
    public void rejectsUnsafeMediaUrls() {
        assertNull(CaptureActivity.safeMediaUrl("http://cdn.example.net/a.m3u8"));
        assertNull(CaptureActivity.safeMediaUrl("https://127.0.0.1/a.m3u8"));
        assertNull(CaptureActivity.safeMediaUrl("https://192.168.1.5/a.m3u8"));
        assertNull(CaptureActivity.safeMediaUrl("https://user:pass@cdn.example.net/a.m3u8"));
        assertNull(CaptureActivity.safeMediaUrl("https://cdn.example.net/a.mp4"));
    }

    @Test
    public void scoresExplicitQuality() {
        assertTrue(CaptureActivity.qualityScore("https://cdn/x/1080p/index.m3u8")
                > CaptureActivity.qualityScore("https://cdn/x/720p/index.m3u8"));
    }
}
