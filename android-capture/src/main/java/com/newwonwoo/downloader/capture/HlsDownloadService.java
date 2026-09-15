package com.newwonwoo.downloader.capture;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.MediaStore;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public final class HlsDownloadService extends Service {
    public static final String EXTRA_STREAM = "stream";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_PAGE = "page";
    public static final String EXTRA_COOKIE = "cookie";

    private static final String CHANNEL_ID = "video_downloads";
    private static final int NOTIFICATION_ID = 4107;
    private static final int NETWORK_WORKERS = 12;
    private static final int MAX_ATTEMPTS = 4;
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 20_000;
    private static final int MAX_OBJECT_BYTES = 32 * 1024 * 1024;
    private static final List<String> MEDIA_SUFFIXES = List.of("surrit.com", "nineyu.com");
    private static final Pattern ATTR = Pattern.compile("([A-Z0-9-]+)=(\\\"[^\\\"]*\\\"|[^,]*)", Pattern.CASE_INSENSITIVE);

    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private volatile Thread jobThread;
    private NotificationManager notifications;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        notifications = getSystemService(NotificationManager.class);
        ensureChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        String stream = intent.getStringExtra(EXTRA_STREAM);
        String title = intent.getStringExtra(EXTRA_TITLE);
        String page = intent.getStringExtra(EXTRA_PAGE);
        String cookie = intent.getStringExtra(EXTRA_COOKIE);
        if (!allowedMediaUrl(stream)) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        startForeground(NOTIFICATION_ID, progressNotification("직접 다운로드 준비 중", 0, true));
        if (jobThread != null && jobThread.isAlive()) {
            return START_NOT_STICKY;
        }
        cancelled.set(false);
        acquireWakeLock();
        jobThread = new Thread(() -> {
            try {
                Uri saved = runDownload(stream, title, page, cookie);
                if (!cancelled.get()) {
                    notifications.notify(NOTIFICATION_ID, completeNotification(saved, title));
                }
            } catch (DirectUnsupportedException unsupported) {
                notifications.notify(NOTIFICATION_ID, fallbackNotification(stream, page, title,
                        "이 영상 형식은 서버 저장 방식이 필요합니다."));
            } catch (Exception error) {
                notifications.notify(NOTIFICATION_ID, failureNotification(
                        "다운로드 실패 · 다시 공유해서 시도해 주세요."));
            } finally {
                releaseWakeLock();
                stopForeground(false);
                stopSelf(startId);
            }
        }, "direct-hls-download");
        jobThread.start();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        cancelled.set(true);
        releaseWakeLock();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Uri runDownload(String stream, String title, String page, String cookie) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            throw new DirectUnsupportedException("scoped storage required");
        }
        File work = new File(getCacheDir(), "hls-" + System.nanoTime());
        if (!work.mkdirs() && !work.isDirectory()) throw new IOException("temp directory");
        try {
            Playlist playlist = resolveMediaPlaylist(stream, page, cookie, 0);
            if (playlist.initMap != null) throw new DirectUnsupportedException("fMP4 playlist");
            if (playlist.segments.isEmpty()) throw new IOException("empty playlist");

            downloadSegments(playlist, work, page, cookie);
            File ts = new File(work, "joined.ts");
            joinSegments(playlist.segments.size(), work, ts);
            notifications.notify(NOTIFICATION_ID, progressNotification("MP4로 정리 중", 99, false));

            File mp4 = new File(work, "output.mp4");
            remuxTsToMp4(ts, mp4);
            return saveToDownloads(mp4, safeName(title));
        } finally {
            deleteRecursively(work);
        }
    }

    private Playlist resolveMediaPlaylist(String rawUrl, String page, String cookie, int depth) throws Exception {
        if (depth > 3) throw new IOException("playlist depth");
        String text = new String(fetchBytes(rawUrl, null, page, cookie), java.nio.charset.StandardCharsets.UTF_8);
        if (!text.contains("#EXTM3U")) throw new IOException("invalid playlist");
        if (text.contains("#EXT-X-STREAM-INF")) {
            List<Variant> variants = new ArrayList<>();
            String[] lines = text.split("\\r?\\n");
            for (int i = 0; i < lines.length; i++) {
                String line = lines[i].trim();
                if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
                Map<String, String> attrs = attrs(line);
                int bandwidth = intValue(attrs.get("BANDWIDTH"));
                int height = resolutionHeight(attrs.get("RESOLUTION"));
                for (int j = i + 1; j < lines.length; j++) {
                    String candidate = lines[j].trim();
                    if (candidate.isEmpty()) continue;
                    if (!candidate.startsWith("#")) {
                        variants.add(new Variant(resolve(rawUrl, candidate), height, bandwidth));
                        break;
                    }
                }
            }
            if (variants.isEmpty()) throw new IOException("master playlist empty");
            Variant best = variants.stream().max(Comparator.comparingInt((Variant v) -> v.height)
                    .thenComparingInt(v -> v.bandwidth)).orElseThrow();
            return resolveMediaPlaylist(best.url, page, cookie, depth + 1);
        }
        return parseMediaPlaylist(rawUrl, text);
    }

    private Playlist parseMediaPlaylist(String playlistUrl, String text) throws Exception {
        List<Segment> segments = new ArrayList<>();
        String initMap = null;
        KeyInfo key = null;
        int sequence = 0;
        String pendingRange = null;
        long previousRangeEnd = -1;
        String[] lines = text.split("\\r?\\n");
        for (String raw : lines) {
            String line = raw.trim();
            if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
                sequence = intValue(line.substring(line.indexOf(':') + 1));
            } else if (line.startsWith("#EXT-X-MAP:")) {
                Map<String, String> values = attrs(line);
                if (values.get("URI") != null) initMap = resolve(playlistUrl, values.get("URI"));
            } else if (line.startsWith("#EXT-X-KEY:")) {
                Map<String, String> values = attrs(line);
                String method = values.get("METHOD");
                if (method == null || "NONE".equalsIgnoreCase(method)) {
                    key = null;
                } else if ("AES-128".equalsIgnoreCase(method) && values.get("URI") != null) {
                    key = new KeyInfo(resolve(playlistUrl, values.get("URI")), values.get("IV"));
                } else {
                    throw new DirectUnsupportedException("unsupported HLS encryption");
                }
            } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
                pendingRange = line.substring(line.indexOf(':') + 1).trim();
            } else if (!line.isEmpty() && !line.startsWith("#")) {
                ByteRange range = parseRange(pendingRange, previousRangeEnd);
                if (range != null) previousRangeEnd = range.end;
                segments.add(new Segment(resolve(playlistUrl, line), range,
                        sequence + segments.size(), key));
                pendingRange = null;
            }
        }
        return new Playlist(initMap, segments);
    }

    private void downloadSegments(Playlist playlist, File work, String page, String cookie) throws Exception {
        int total = playlist.segments.size();
        int workers = Math.min(NETWORK_WORKERS, Math.max(1, total));
        ExecutorService pool = Executors.newFixedThreadPool(workers);
        ExecutorCompletionService<Integer> completion = new ExecutorCompletionService<>(pool);
        AtomicInteger done = new AtomicInteger();
        Map<String, byte[]> keyCache = new java.util.concurrent.ConcurrentHashMap<>();
        try {
            for (int i = 0; i < total; i++) {
                final int index = i;
                completion.submit(() -> {
                    if (cancelled.get()) throw new IOException("cancelled");
                    Segment segment = playlist.segments.get(index);
                    byte[] data = fetchBytes(segment.url, segment.range, page, cookie);
                    if (segment.key != null) {
                        byte[] keyBytes = keyCache.get(segment.key.url);
                        if (keyBytes == null) {
                            keyBytes = fetchBytes(segment.key.url, null, page, cookie);
                            keyCache.put(segment.key.url, keyBytes);
                        }
                        data = decrypt(data, keyBytes, segment.key.iv, segment.sequence);
                    }
                    try (FileOutputStream output = new FileOutputStream(new File(work, String.format(Locale.ROOT, "%06d.ts", index)))) {
                        output.write(data);
                    }
                    return index;
                });
            }
            for (int i = 0; i < total; i++) {
                Future<Integer> future = completion.take();
                future.get();
                int finished = done.incrementAndGet();
                int percent = Math.min(97, Math.max(1, finished * 97 / total));
                notifications.notify(NOTIFICATION_ID, progressNotification(
                        "영상 직접 다운로드 중 · " + finished + "/" + total, percent, false));
            }
        } finally {
            pool.shutdownNow();
        }
    }

    private byte[] fetchBytes(String rawUrl, ByteRange range, String page, String cookie) throws Exception {
        if (!allowedMediaUrl(rawUrl)) throw new IOException("unsupported media host");
        Exception last = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (cancelled.get()) throw new IOException("cancelled");
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(rawUrl).openConnection();
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setInstanceFollowRedirects(true);
                connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36");
                connection.setRequestProperty("Accept", "*/*");
                connection.setRequestProperty("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.5");
                connection.setRequestProperty("Referer", page == null || page.isBlank() ? "https://njavtv.com/" : page);
                connection.setRequestProperty("Origin", "https://njavtv.com");
                if (cookie != null && !cookie.isBlank()) connection.setRequestProperty("Cookie", cookie);
                if (range != null) connection.setRequestProperty("Range", "bytes=" + range.start + "-" + range.end);
                int status = connection.getResponseCode();
                if (status != 200 && status != 206) throw new IOException("upstream " + status);
                try (InputStream input = connection.getInputStream()) {
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = input.read(buffer)) >= 0) {
                        output.write(buffer, 0, read);
                        if (output.size() > MAX_OBJECT_BYTES) throw new IOException("media object too large");
                    }
                    if (output.size() == 0) throw new IOException("empty media object");
                    return output.toByteArray();
                }
            } catch (Exception error) {
                last = error;
                if (attempt < MAX_ATTEMPTS) Thread.sleep(250L * attempt);
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
        throw last == null ? new IOException("download failed") : last;
    }

    private static byte[] decrypt(byte[] data, byte[] key, String rawIv, int sequence)
            throws GeneralSecurityException {
        if (key.length != 16) throw new GeneralSecurityException("invalid AES key");
        byte[] iv = new byte[16];
        if (rawIv != null && !rawIv.isBlank()) {
            String hex = rawIv.toLowerCase(Locale.ROOT).replaceFirst("^0x", "");
            while (hex.length() < 32) hex = "0" + hex;
            if (hex.length() > 32) hex = hex.substring(hex.length() - 32);
            for (int i = 0; i < 16; i++) iv[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        } else {
            long value = sequence & 0xffffffffL;
            for (int i = 15; i >= 12; i--) {
                iv[i] = (byte) (value & 0xff);
                value >>>= 8;
            }
        }
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new IvParameterSpec(iv));
        return cipher.doFinal(data);
    }

    private static void joinSegments(int count, File work, File joined) throws IOException {
        try (FileChannel output = new FileOutputStream(joined).getChannel()) {
            for (int i = 0; i < count; i++) {
                File part = new File(work, String.format(Locale.ROOT, "%06d.ts", i));
                try (FileChannel input = new FileInputStream(part).getChannel()) {
                    long position = 0;
                    while (position < input.size()) position += input.transferTo(position, input.size() - position, output);
                }
            }
        }
    }

    private static void remuxTsToMp4(File source, File target) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        MediaMuxer muxer = null;
        try {
            extractor.setDataSource(source.getAbsolutePath());
            int trackCount = extractor.getTrackCount();
            if (trackCount <= 0) throw new IOException("no media tracks");
            muxer = new MediaMuxer(target.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            Map<Integer, Integer> trackMap = new HashMap<>();
            for (int i = 0; i < trackCount; i++) {
                MediaFormat format = extractor.getTrackFormat(i);
                String mime = format.getString(MediaFormat.KEY_MIME);
                if (mime != null && (mime.startsWith("video/") || mime.startsWith("audio/"))) {
                    trackMap.put(i, muxer.addTrack(format));
                    extractor.selectTrack(i);
                }
            }
            if (trackMap.isEmpty()) throw new IOException("unsupported tracks");
            muxer.start();
            ByteBuffer buffer = ByteBuffer.allocate(8 * 1024 * 1024);
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            while (true) {
                buffer.clear();
                int size = extractor.readSampleData(buffer, 0);
                if (size < 0) break;
                int sourceTrack = extractor.getSampleTrackIndex();
                Integer targetTrack = trackMap.get(sourceTrack);
                if (targetTrack != null) {
                    info.offset = 0;
                    info.size = size;
                    info.presentationTimeUs = Math.max(0L, extractor.getSampleTime());
                    info.flags = extractor.getSampleFlags();
                    muxer.writeSampleData(targetTrack, buffer, info);
                }
                extractor.advance();
            }
        } finally {
            extractor.release();
            if (muxer != null) {
                try { muxer.stop(); } catch (RuntimeException ignored) {}
                muxer.release();
            }
        }
        if (!target.isFile() || target.length() < 1024) throw new IOException("MP4 output invalid");
    }

    private Uri saveToDownloads(File mp4, String baseName) throws IOException {
        ContentResolver resolver = getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Video.Media.DISPLAY_NAME, baseName + ".mp4");
        values.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
        values.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/VideoSaveTool");
        values.put(MediaStore.Video.Media.IS_PENDING, 1);
        Uri collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri uri = resolver.insert(collection, values);
        if (uri == null) throw new IOException("MediaStore insert failed");
        try {
            try (InputStream input = new FileInputStream(mp4); OutputStream output = resolver.openOutputStream(uri, "w")) {
                if (output == null) throw new IOException("MediaStore output failed");
                byte[] buffer = new byte[256 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.Video.Media.IS_PENDING, 0);
            resolver.update(uri, ready, null, null);
            return uri;
        } catch (Exception error) {
            resolver.delete(uri, null, null);
            throw error;
        }
    }

    private Notification progressNotification(String text, int progress, boolean indeterminate) {
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("영상 저장 도구")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setProgress(100, Math.max(0, progress), indeterminate)
                .build();
    }

    private Notification completeNotification(Uri saved, String title) {
        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(saved, "video/mp4")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent content = PendingIntent.getActivity(this, 101, view,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("저장 완료")
                .setContentText(safeName(title) + ".mp4")
                .setAutoCancel(true)
                .setContentIntent(content)
                .build();
    }

    private Notification failureNotification(String message) {
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle("영상 저장 실패")
                .setContentText(message)
                .setAutoCancel(true)
                .build();
    }

    private Notification fallbackNotification(String stream, String page, String title, String message) {
        Uri target = Uri.parse("https://downloader-web-1gqu.onrender.com/").buildUpon()
                .appendQueryParameter("capture", "1")
                .appendQueryParameter("page", page == null ? "" : page)
                .appendQueryParameter("stream", stream)
                .appendQueryParameter("title", title == null ? "영상" : title)
                .build();
        Intent open = new Intent(Intent.ACTION_VIEW, target);
        PendingIntent action = PendingIntent.getActivity(this, 102, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle("서버 방식으로 계속")
                .setContentText(message)
                .setAutoCancel(true)
                .setContentIntent(action)
                .build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "영상 다운로드",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("영상 직접 다운로드 진행 상태");
            notifications.createNotificationChannel(channel);
        }
    }

    private void acquireWakeLock() {
        try {
            PowerManager manager = getSystemService(PowerManager.class);
            wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VideoSaveTool:DirectDownload");
            wakeLock.acquire(60 * 60 * 1000L);
        } catch (RuntimeException ignored) {}
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (RuntimeException ignored) {}
        wakeLock = null;
    }

    static boolean allowedMediaUrl(String raw) {
        try {
            URI uri = URI.create(raw);
            String host = uri.getHost();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || uri.getRawUserInfo() != null) return false;
            String normalized = host.toLowerCase(Locale.ROOT);
            for (String suffix : MEDIA_SUFFIXES) {
                if (normalized.equals(suffix) || normalized.endsWith("." + suffix)) return true;
            }
            return false;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static Map<String, String> attrs(String line) {
        Map<String, String> values = new HashMap<>();
        Matcher matcher = ATTR.matcher(line);
        while (matcher.find()) {
            String value = matcher.group(2);
            if (value != null && value.startsWith("\"") && value.endsWith("\"")) value = value.substring(1, value.length() - 1);
            values.put(matcher.group(1).toUpperCase(Locale.ROOT), value);
        }
        return values;
    }

    private static String resolve(String base, String relative) throws Exception {
        return new URL(new URL(base), relative).toString();
    }

    private static int intValue(String raw) {
        try { return Integer.parseInt(raw == null ? "0" : raw.trim()); } catch (NumberFormatException ignored) { return 0; }
    }

    private static int resolutionHeight(String raw) {
        if (raw == null) return 0;
        int x = raw.toLowerCase(Locale.ROOT).indexOf('x');
        return x < 0 ? 0 : intValue(raw.substring(x + 1));
    }

    private static ByteRange parseRange(String raw, long previousEnd) throws DirectUnsupportedException {
        if (raw == null || raw.isBlank()) return null;
        String[] parts = raw.split("@", 2);
        long length;
        try { length = Long.parseLong(parts[0]); } catch (NumberFormatException error) { throw new DirectUnsupportedException("invalid byte range"); }
        long start;
        if (parts.length == 2) {
            try { start = Long.parseLong(parts[1]); } catch (NumberFormatException error) { throw new DirectUnsupportedException("invalid byte range"); }
        } else {
            if (previousEnd < 0) throw new DirectUnsupportedException("implicit byte range");
            start = previousEnd + 1;
        }
        return new ByteRange(start, start + length - 1);
    }

    private static String safeName(String raw) {
        String value = raw == null ? "video" : raw.replaceAll("[\\\\/:*?\"<>|\\r\\n]+", "_").trim();
        if (value.isEmpty()) value = "video";
        return value.length() > 100 ? value.substring(0, 100) : value;
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private record Variant(String url, int height, int bandwidth) {}
    private record ByteRange(long start, long end) {}
    private record KeyInfo(String url, String iv) {}
    private record Segment(String url, ByteRange range, int sequence, KeyInfo key) {}
    private record Playlist(String initMap, List<Segment> segments) {}

    private static final class DirectUnsupportedException extends Exception {
        DirectUnsupportedException(String message) { super(message); }
    }
}
