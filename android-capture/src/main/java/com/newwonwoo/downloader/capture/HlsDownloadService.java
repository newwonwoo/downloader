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
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
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
    public static final String EXTRA_REFERER = "referer";
    public static final String EXTRA_ORIGIN = "origin";
    public static final String EXTRA_USER_AGENT = "userAgent";

    private static final String TAG = "VideoSaveDownload";
    private static final String CHANNEL_ID = "video_downloads";
    private static final int NOTIFICATION_ID = 4107;
    private static final int NETWORK_WORKERS = 12;
    private static final int MAX_ATTEMPTS = 4;
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 25_000;
    private static final int MAX_OBJECT_BYTES = 48 * 1024 * 1024;
    private static final String DEFAULT_UA = "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36";
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
        String referer = intent.getStringExtra(EXTRA_REFERER);
        String origin = intent.getStringExtra(EXTRA_ORIGIN);
        String userAgent = intent.getStringExtra(EXTRA_USER_AGENT);
        if (!safeExternalHttps(stream)) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        FetchContext context = new FetchContext(
                blank(page), blank(referer), blank(origin), blank(userAgent), blank(cookie));
        startForeground(NOTIFICATION_ID, progressNotification("스트림 연결 확인 중", 0, true));
        if (jobThread != null && jobThread.isAlive()) return START_REDELIVER_INTENT;

        cancelled.set(false);
        acquireWakeLock();
        jobThread = new Thread(() -> {
            try {
                Uri saved = runDownload(stream, title, context);
                if (!cancelled.get()) notifications.notify(NOTIFICATION_ID, completeNotification(saved, title));
            } catch (DirectUnsupportedException unsupported) {
                Log.w(TAG, "unsupported direct HLS: " + unsupported.getMessage());
                notifications.notify(NOTIFICATION_ID, failureNotification("이 영상의 HLS 형식은 아직 직접 저장을 지원하지 않습니다."));
            } catch (Exception error) {
                Log.e(TAG, "direct HLS failed", error);
                notifications.notify(NOTIFICATION_ID, failureNotification(userFailureMessage(error)));
            } finally {
                releaseWakeLock();
                stopForeground(false);
                stopSelf(startId);
            }
        }, "direct-hls-download");
        jobThread.start();
        return START_REDELIVER_INTENT;
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

    private Uri runDownload(String stream, String title, FetchContext context) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            throw new DirectUnsupportedException("Android 10 or newer required");
        }
        File work = new File(getCacheDir(), "hls-" + System.nanoTime());
        if (!work.mkdirs() && !work.isDirectory()) throw new IOException("temp directory");
        try {
            Playlist playlist = resolveMediaPlaylist(stream, context, 0);
            if (playlist.segments.isEmpty()) throw new IOException("empty playlist");
            Log.i(TAG, "stream validated segments=" + playlist.segments.size());
            notifications.notify(NOTIFICATION_ID, progressNotification("스트림 확인 완료 · 다운로드 시작", 1, false));

            Map<String, byte[]> keyCache = new ConcurrentHashMap<>();
            byte[] initBytes = null;
            if (playlist.initMap != null) {
                initBytes = fetchBytes(playlist.initMap.url, playlist.initMap.range, context);
                if (playlist.initMap.key != null) {
                    if (playlist.initMap.key.iv == null || playlist.initMap.key.iv.isBlank()) {
                        throw new DirectUnsupportedException("encrypted init map requires IV");
                    }
                    byte[] key = fetchKey(playlist.initMap.key, context, keyCache);
                    initBytes = decrypt(initBytes, key, playlist.initMap.key.iv, 0);
                }
            }

            downloadSegments(playlist, work, context, keyCache);
            notifications.notify(NOTIFICATION_ID, progressNotification("MP4로 정리 중", 98, false));

            File mp4 = new File(work, "output.mp4");
            if (initBytes != null) {
                joinFragmentedMp4(initBytes, playlist.segments.size(), work, mp4);
            } else {
                File ts = new File(work, "joined.ts");
                joinSegments(playlist.segments.size(), work, ts);
                remuxTsToMp4(ts, mp4);
            }
            return saveToDownloads(mp4, safeName(title));
        } finally {
            deleteRecursively(work);
        }
    }

    private Playlist resolveMediaPlaylist(String rawUrl, FetchContext context, int depth) throws Exception {
        if (depth > 4) throw new IOException("playlist depth");
        byte[] bytes = fetchBytes(rawUrl, null, context);
        String text = new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
        if (!text.contains("#EXTM3U")) throw new IOException("invalid playlist");

        if (text.contains("#EXT-X-STREAM-INF")) {
            List<Variant> variants = new ArrayList<>();
            String[] lines = text.split("\\r?\\n");
            for (int i = 0; i < lines.length; i++) {
                String line = lines[i].trim();
                if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
                Map<String, String> meta = attrs(line);
                int bandwidth = intValue(meta.get("BANDWIDTH"));
                int height = resolutionHeight(meta.get("RESOLUTION"));
                for (int j = i + 1; j < lines.length; j++) {
                    String candidate = lines[j].trim();
                    if (candidate.isEmpty()) continue;
                    if (!candidate.startsWith("#")) {
                        String resolved = resolve(rawUrl, candidate);
                        if (safeExternalHttps(resolved)) variants.add(new Variant(resolved, height, bandwidth));
                        break;
                    }
                }
            }
            if (variants.isEmpty()) throw new IOException("master playlist empty");
            Variant best = variants.stream()
                    .max(Comparator.comparingInt((Variant v) -> v.height).thenComparingInt(v -> v.bandwidth))
                    .orElseThrow();
            return resolveMediaPlaylist(best.url, context, depth + 1);
        }
        return parseMediaPlaylist(rawUrl, text);
    }

    static Playlist parseMediaPlaylist(String playlistUrl, String text) throws Exception {
        List<Segment> segments = new ArrayList<>();
        InitMap initMap = null;
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
                String uri = values.get("URI");
                if (uri != null) {
                    ByteRange range = parseRange(values.get("BYTERANGE"), -1);
                    String resolved = resolve(playlistUrl, uri);
                    if (!safeExternalHttps(resolved)) throw new IOException("unsafe init map");
                    initMap = new InitMap(resolved, range, key);
                }
            } else if (line.startsWith("#EXT-X-KEY:")) {
                Map<String, String> values = attrs(line);
                String method = values.get("METHOD");
                if (method == null || "NONE".equalsIgnoreCase(method)) {
                    key = null;
                } else if ("AES-128".equalsIgnoreCase(method) && values.get("URI") != null) {
                    String resolved = resolve(playlistUrl, values.get("URI"));
                    if (!safeExternalHttps(resolved)) throw new IOException("unsafe key URL");
                    key = new KeyInfo(resolved, values.get("IV"));
                } else {
                    throw new DirectUnsupportedException("unsupported HLS encryption");
                }
            } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
                pendingRange = line.substring(line.indexOf(':') + 1).trim();
            } else if (!line.isEmpty() && !line.startsWith("#")) {
                ByteRange range = parseRange(pendingRange, previousRangeEnd);
                if (range != null) previousRangeEnd = range.end;
                String resolved = resolve(playlistUrl, line);
                if (!safeExternalHttps(resolved)) throw new IOException("unsafe segment URL");
                segments.add(new Segment(resolved, range, sequence + segments.size(), key));
                pendingRange = null;
            }
        }
        return new Playlist(initMap, segments);
    }

    private void downloadSegments(Playlist playlist, File work, FetchContext context,
                                  Map<String, byte[]> keyCache) throws Exception {
        int total = playlist.segments.size();
        int workers = Math.min(NETWORK_WORKERS, Math.max(1, total));
        ExecutorService pool = Executors.newFixedThreadPool(workers);
        ExecutorCompletionService<Integer> completion = new ExecutorCompletionService<>(pool);
        AtomicInteger done = new AtomicInteger();
        try {
            for (int i = 0; i < total; i++) {
                final int index = i;
                completion.submit(() -> {
                    if (cancelled.get()) throw new IOException("cancelled");
                    Segment segment = playlist.segments.get(index);
                    byte[] data = fetchBytes(segment.url, segment.range, context);
                    if (segment.key != null) {
                        byte[] key = fetchKey(segment.key, context, keyCache);
                        data = decrypt(data, key, segment.key.iv, segment.sequence);
                    }
                    try (FileOutputStream output = new FileOutputStream(segmentFile(work, index))) {
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

    private byte[] fetchKey(KeyInfo keyInfo, FetchContext context, Map<String, byte[]> keyCache) throws Exception {
        byte[] cached = keyCache.get(keyInfo.url);
        if (cached != null) return cached;
        byte[] loaded = fetchBytes(keyInfo.url, null, context);
        if (loaded.length != 16) throw new GeneralSecurityException("invalid AES key");
        keyCache.put(keyInfo.url, loaded);
        return loaded;
    }

    private byte[] fetchBytes(String rawUrl, ByteRange range, FetchContext context) throws Exception {
        if (!safeExternalHttps(rawUrl)) throw new IOException("unsafe media URL");
        Exception last = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (cancelled.get()) throw new IOException("cancelled");
            HttpURLConnection connection = null;
            boolean success = false;
            try {
                connection = (HttpURLConnection) new URL(rawUrl).openConnection();
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setInstanceFollowRedirects(true);
                connection.setRequestProperty("User-Agent", context.userAgent.isBlank() ? DEFAULT_UA : context.userAgent);
                connection.setRequestProperty("Accept", "*/*");
                connection.setRequestProperty("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.5");
                String referer = safeHeaderUrl(context.referer) ? context.referer : context.page;
                if (safeHeaderUrl(referer)) connection.setRequestProperty("Referer", referer);
                if (safeOrigin(context.origin)) connection.setRequestProperty("Origin", context.origin);
                if (!context.cookie.isBlank()) connection.setRequestProperty("Cookie", context.cookie);
                if (range != null) connection.setRequestProperty("Range", "bytes=" + range.start + "-" + range.end);

                int status = connection.getResponseCode();
                String finalUrl = connection.getURL() == null ? rawUrl : connection.getURL().toString();
                if (!safeExternalHttps(finalUrl)) throw new IOException("unsafe redirect");
                if (status != 200 && status != 206) throw new IOException("upstream " + status);

                try (InputStream input = connection.getInputStream()) {
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    byte[] buffer = new byte[128 * 1024];
                    int read;
                    while ((read = input.read(buffer)) >= 0) {
                        if (read == 0) continue;
                        output.write(buffer, 0, read);
                        if (output.size() > MAX_OBJECT_BYTES) throw new IOException("media object too large");
                    }
                    if (output.size() == 0) throw new IOException("empty media object");
                    success = true;
                    return output.toByteArray();
                }
            } catch (Exception error) {
                last = error;
                if (!retryable(error) || attempt >= MAX_ATTEMPTS) break;
                Thread.sleep(250L * attempt * attempt);
            } finally {
                if (connection != null && !success) connection.disconnect();
            }
        }
        throw last == null ? new IOException("download failed") : last;
    }

    private static boolean retryable(Exception error) {
        if (error instanceof SocketTimeoutException) return true;
        String message = error.getMessage() == null ? "" : error.getMessage().toLowerCase(Locale.ROOT);
        if (message.contains("reset") || message.contains("timed out") || message.contains("unexpected end")) return true;
        Matcher status = Pattern.compile("upstream (\\d{3})").matcher(message);
        if (!status.find()) return true;
        int code = Integer.parseInt(status.group(1));
        return code == 408 || code == 425 || code == 429 || code == 500 || code == 502 || code == 503 || code == 504;
    }

    static boolean safeExternalHttps(String raw) {
        if (raw == null || raw.isBlank()) return false;
        try {
            URI uri = URI.create(raw.trim());
            String host = uri.getHost();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || uri.getRawUserInfo() != null) return false;
            if (uri.getPort() != -1 && uri.getPort() != 443) return false;
            return !CaptureActivity.isLocalOrPrivateHost(host);
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static boolean safeHeaderUrl(String raw) {
        if (raw == null || raw.isBlank()) return false;
        try {
            URI uri = URI.create(raw.trim());
            return ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))
                    && uri.getHost() != null && uri.getRawUserInfo() == null;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static boolean safeOrigin(String raw) {
        if (!safeHeaderUrl(raw)) return false;
        try {
            URI uri = URI.create(raw.trim());
            return uri.getPath() == null || uri.getPath().isEmpty() || "/".equals(uri.getPath());
        } catch (RuntimeException ignored) {
            return false;
        }
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

    private static File segmentFile(File work, int index) {
        return new File(work, String.format(Locale.ROOT, "%06d.seg", index));
    }

    private static void joinSegments(int count, File work, File joined) throws IOException {
        try (FileChannel output = new FileOutputStream(joined).getChannel()) {
            for (int i = 0; i < count; i++) copyFile(segmentFile(work, i), output);
        }
    }

    private static void joinFragmentedMp4(byte[] initBytes, int count, File work, File target) throws IOException {
        try (FileOutputStream file = new FileOutputStream(target); FileChannel output = file.getChannel()) {
            file.write(initBytes);
            for (int i = 0; i < count; i++) copyFile(segmentFile(work, i), output);
        }
        if (target.length() < 1024) throw new IOException("fMP4 output invalid");
    }

    private static void copyFile(File source, FileChannel output) throws IOException {
        try (FileChannel input = new FileInputStream(source).getChannel()) {
            long position = 0;
            long size = input.size();
            while (position < size) {
                long moved = input.transferTo(position, size - position, output);
                if (moved <= 0) throw new IOException("segment join stalled");
                position += moved;
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
                while ((read = input.read(buffer)) >= 0) {
                    if (read > 0) output.write(buffer, 0, read);
                }
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.Video.Media.IS_PENDING, 0);
            resolver.update(uri, ready, null, null);
            return uri;
        } catch (Exception error) {
            resolver.delete(uri, null, null);
            if (error instanceof IOException io) throw io;
            throw new IOException(error);
        }
    }

    private Notification progressNotification(String text, int progress, boolean indeterminate) {
        return notificationBuilder()
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
        return notificationBuilder()
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("저장 완료")
                .setContentText(safeName(title) + ".mp4")
                .setAutoCancel(true)
                .setContentIntent(content)
                .build();
    }

    private Notification failureNotification(String message) {
        Intent reopen = new Intent(this, CaptureActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent content = PendingIntent.getActivity(this, 103, reopen,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return notificationBuilder()
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle("영상 저장 실패")
                .setContentText(message)
                .setAutoCancel(true)
                .setContentIntent(content)
                .build();
    }

    private Notification.Builder notificationBuilder() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) return new Notification.Builder(this, CHANNEL_ID);
        return new Notification.Builder(this);
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

    private static String userFailureMessage(Exception error) {
        String message = error.getMessage() == null ? "" : error.getMessage().toLowerCase(Locale.ROOT);
        if (error instanceof UnknownHostException || message.contains("unable to resolve host") || message.contains("name not resolved")) {
            return "영상 서버 주소를 찾지 못했습니다. 네트워크/DNS를 확인한 뒤 다시 시도해 주세요.";
        }
        if (error instanceof SocketTimeoutException || message.contains("timed out")) {
            return "영상 서버 응답이 지연됐습니다. 다시 공유해서 시도해 주세요.";
        }
        if (message.contains("upstream 401") || message.contains("upstream 403")) {
            return "영상 서버 인증이 만료됐습니다. 원본 페이지를 새로 열고 다시 공유해 주세요.";
        }
        if (message.contains("upstream 404")) return "영상 주소가 만료됐습니다. 다시 공유해 주세요.";
        return "다운로드에 실패했습니다. 원본 페이지를 새로 열고 다시 공유해 주세요.";
    }

    private static Map<String, String> attrs(String line) {
        Map<String, String> values = new HashMap<>();
        Matcher matcher = ATTR.matcher(line);
        while (matcher.find()) {
            String value = matcher.group(2);
            if (value != null && value.startsWith("\"") && value.endsWith("\"")) {
                value = value.substring(1, value.length() - 1);
            }
            values.put(matcher.group(1).toUpperCase(Locale.ROOT), value);
        }
        return values;
    }

    private static String resolve(String base, String relative) throws Exception {
        return new URL(new URL(base), relative).toString();
    }

    private static int intValue(String raw) {
        try { return Integer.parseInt(raw == null ? "0" : raw.trim()); }
        catch (NumberFormatException ignored) { return 0; }
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
        try { length = Long.parseLong(parts[0]); }
        catch (NumberFormatException error) { throw new DirectUnsupportedException("invalid byte range"); }
        if (length <= 0) throw new DirectUnsupportedException("invalid byte range");
        long start;
        if (parts.length == 2) {
            try { start = Long.parseLong(parts[1]); }
            catch (NumberFormatException error) { throw new DirectUnsupportedException("invalid byte range"); }
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

    private static String blank(String value) {
        return value == null ? "" : value.trim();
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    record Variant(String url, int height, int bandwidth) {}
    record ByteRange(long start, long end) {}
    record KeyInfo(String url, String iv) {}
    record InitMap(String url, ByteRange range, KeyInfo key) {}
    record Segment(String url, ByteRange range, int sequence, KeyInfo key) {}
    record Playlist(InitMap initMap, List<Segment> segments) {}
    record FetchContext(String page, String referer, String origin, String userAgent, String cookie) {}

    static final class DirectUnsupportedException extends Exception {
        DirectUnsupportedException(String message) { super(message); }
    }
}
