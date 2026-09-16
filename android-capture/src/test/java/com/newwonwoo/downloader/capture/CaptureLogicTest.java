package com.newwonwoo.downloader.capture;

import org.junit.Test;

import static org.junit.Assert.*;

public class CaptureLogicTest {
    @Test
    public void extractsExactProblemUrl() {
        assertEquals(
                "https://njavtv.com/ko/dvaj-041-uncensored-leak",
                CaptureActivity.extractSourceUrl("https://njavtv.com/ko/dvaj-041-uncensored-leak")
        );
    }

    @Test
    public void extractsUrlFromSharedTextAndTrimsPunctuation() {
        assertEquals(
                "https://njavtv.com/ko/dvaj-041-uncensored-leak",
                CaptureActivity.extractSourceUrl("영상 공유 https://njavtv.com/ko/dvaj-041-uncensored-leak),")
        );
    }

    @Test
    public void rejectsLookalikeSourceHosts() {
        assertFalse(CaptureActivity.isAllowedSource("https://njavtv.com.evil.example/ko/dvaj-041"));
        assertFalse(CaptureActivity.isAllowedSource("http://njavtv.com/ko/dvaj-041"));
    }

    @Test
    public void acceptsOnlyExpectedHlsCdnUrls() {
        assertEquals("https://surrit.com/path/master.m3u8", CaptureActivity.allowedMedia("https://surrit.com/path/master.m3u8"));
        assertEquals("https://cdn.nineyu.com/a/video.m3u8?token=x", CaptureActivity.allowedMedia("https://cdn.nineyu.com/a/video.m3u8?token=x"));
        assertNull(CaptureActivity.allowedMedia("https://surrit.com/path/video.mp4"));
        assertNull(CaptureActivity.allowedMedia("https://surrit.com.evil.example/path/master.m3u8"));
    }
}
