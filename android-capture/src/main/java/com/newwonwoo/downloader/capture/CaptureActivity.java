package com.newwonwoo.downloader.capture;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class CaptureActivity extends Activity {
    private static final String TAG = "VideoSaveCapture";
    private static final String DOWNLOADER_URL = "https://downloader-web-1gqu.onrender.com/";
    private static final Set<String> SOURCE_HOSTS = Set.of("njavtv.com", "www.njavtv.com");
    private static final Pattern SHARED_URL = Pattern.compile("https://(?:www\\.)?njavtv\\.com/[^\\s<>\\\"']+", Pattern.CASE_INSENSITIVE);
    private static final Pattern QUALITY = Pattern.compile("(?:/|_|-)(1920x1080|1280x720|842x480|640x360|1080p|720p|480p|360p)(?:/|_|-|\\.|$)", Pattern.CASE_INSENSITIVE);
    private static final long CAPTURE_TIMEOUT_MS = 45_000L;
    private static final long HANDOFF_DELAY_MS = 1_800L;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4108;
    private static final String ANALYSIS_CHANNEL_ID = "video_analysis";
    private static final int ANALYSIS_NOTIFICATION_ID = 4106;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object candidatesLock = new Object();
    private final LinkedHashMap<String, Candidate> candidates = new LinkedHashMap<>();

    private WebView webView;
    private TextView statusView;
    private EditText urlInput;
    private Button openButton;
    private Button playButton;
    private Button retryButton;
    private NotificationManager notifications;
    private String pageUrl;
    private Candidate pendingDirectCandidate;
    private boolean handoffScheduled;
    private boolean handedOff;

    private final Runnable timeoutRunnable = () -> {
        if (handedOff || hasCandidates()) return;
        setStatus("영상 주소를 아직 찾지 못했습니다. 영상 화면에서 재생을 한 번 눌러 주세요.");
        playButton.setVisibility(View.VISIBLE);
        retryButton.setVisibility(View.VISIBLE);
        updateAnalysisNotification("영상 주소를 찾지 못했습니다 · 앱에서 재생을 눌러 주세요");
    };

    private final Runnable handoffRunnable = () -> {
        if (handedOff) return;
        Candidate candidate = bestCandidate();
        if (candidate == null) {
            handoffScheduled = false;
            return;
        }
        handedOff = true;
        mainHandler.removeCallbacks(timeoutRunnable);
        startDirectDownload(candidate);
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        notifications = getSystemService(NotificationManager.class);
        ensureAnalysisChannel();
        buildUi();
        configureWebView();
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        resetCapture();
        handleIntent(intent);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != NOTIFICATION_PERMISSION_REQUEST) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            if (pendingDirectCandidate != null) {
                Candidate candidate = pendingDirectCandidate;
                pendingDirectCandidate = null;
                startDirectDownloadNow(candidate, true);
            } else if (pageUrl != null) {
                updateAnalysisNotification("영상 주소를 찾는 중입니다");
            }
        } else if (pendingDirectCandidate != null) {
            Candidate candidate = pendingDirectCandidate;
            pendingDirectCandidate = null;
            setStatus("알림 권한 없이 다운로드를 시작합니다. 앱을 닫아도 서비스는 계속 시도합니다.");
            startDirectDownloadNow(candidate, false);
        }
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
        if (!handedOff && notifications != null) notifications.cancel(ANALYSIS_NOTIFICATION_ID);
        if (webView != null) {
            webView.removeJavascriptInterface("CaptureBridge");
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        statusView = new TextView(this);
        statusView.setTextSize(16f);
        statusView.setTextColor(Color.rgb(30, 30, 30));
        statusView.setPadding(dp(16), dp(14), dp(16), dp(10));
        statusView.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(statusView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout addressRow = new LinearLayout(this);
        addressRow.setOrientation(LinearLayout.HORIZONTAL);
        addressRow.setPadding(dp(12), 0, dp(12), dp(8));

        urlInput = new EditText(this);
        urlInput.setSingleLine(true);
        urlInput.setHint("https://njavtv.com/...");
        addressRow.addView(urlInput, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        openButton = new Button(this);
        openButton.setText("주소 열기");
        openButton.setOnClickListener(v -> openTypedUrl());
        addressRow.addView(openButton, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(addressRow);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(dp(12), 0, dp(12), dp(8));

        playButton = new Button(this);
        playButton.setText("영상 재생");
        playButton.setVisibility(View.GONE);
        playButton.setOnClickListener(v -> triggerPlayback());
        actions.addView(playButton, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        retryButton = new Button(this);
        retryButton.setText("다시 시도");
        retryButton.setVisibility(View.GONE);
        retryButton.setOnClickListener(v -> retryCapture());
        actions.addView(retryButton, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        root.addView(actions);

        webView = new WebView(this);
        webView.setKeepScreenOn(true);
        root.addView(webView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f));
        setContentView(root);
    }

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new CaptureBridge(), "CaptureBridge");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request != null && request.getUrl() != null) {
                    captureCandidate(request.getUrl().toString(), request.getRequestHeaders());
                }
                return null;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                setStatus("페이지를 여는 중입니다…");
                playButton.setVisibility(View.GONE);
                retryButton.setVisibility(View.GONE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectCaptureBridge();
                softPrimePlayer();
                String title = safeTitle();
                if (looksLikeChallenge(title, url)) {
                    setStatus("보안 확인이 보이면 완료해 주세요. 완료 후 자동으로 다시 찾습니다.");
                    playButton.setVisibility(View.VISIBLE);
                    return;
                }
                if (!hasCandidates()) {
                    setStatus("영상 플레이어의 재생 주소를 찾는 중입니다…");
                    playButton.setVisibility(View.VISIBLE);
                    mainHandler.postDelayed(CaptureActivity.this::softPrimePlayer, 2_000L);
                    mainHandler.postDelayed(CaptureActivity.this::injectCaptureBridge, 4_000L);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request != null && request.isForMainFrame() && !handedOff) {
                    setStatus("페이지를 열지 못했습니다. 다시 시도해 주세요.");
                    retryButton.setVisibility(View.VISIBLE);
                }
            }
        });

        try {
            ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    if (request != null && request.getUrl() != null) {
                        captureCandidate(request.getUrl().toString(), request.getRequestHeaders());
                    }
                    return null;
                }
            });
        } catch (Throwable ignored) {
            // Normal request interception and JavaScript observation remain active.
        }
    }

    private void handleIntent(Intent intent) {
        String source = extractSourceUrl(extractSharedText(intent));
        if (source == null) {
            setStatus("NJAVTV 주소를 붙여넣거나, 삼성 인터넷에서 공유 → 영상 저장 도구를 선택해 주세요.");
            urlInput.setVisibility(View.VISIBLE);
            openButton.setVisibility(View.VISIBLE);
            playButton.setVisibility(View.GONE);
            retryButton.setVisibility(View.GONE);
            return;
        }
        loadSource(source);
    }

    private void openTypedUrl() {
        String source = extractSourceUrl(urlInput.getText() == null ? "" : urlInput.getText().toString());
        if (source == null) {
            setStatus("지원하는 NJAVTV https 주소를 입력해 주세요.");
            return;
        }
        resetCapture();
        loadSource(source);
    }

    private void loadSource(String source) {
        pageUrl = source;
        urlInput.setText(source);
        setStatus("공유된 영상을 확인하고 있습니다…");
        requestNotificationPermissionForStatus();
        updateAnalysisNotification("영상 주소를 찾는 중입니다");
        mainHandler.removeCallbacks(timeoutRunnable);
        mainHandler.postDelayed(timeoutRunnable, CAPTURE_TIMEOUT_MS);
        webView.loadUrl(pageUrl);
    }

    private String extractSharedText(Intent intent) {
        if (intent == null) return "";
        StringBuilder value = new StringBuilder();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            CharSequence subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
            if (text != null) value.append(text).append(' ');
            if (subject != null) value.append(subject);
        } else if (intent.getData() != null) {
            value.append(intent.getData().toString());
        }
        return value.toString().trim();
    }

    static String extractSourceUrl(String raw) {
        if (raw == null) return null;
        String trimmed = trimTrailingPunctuation(raw.trim());
        if (isAllowedSource(trimmed)) return trimmed;
        Matcher matcher = SHARED_URL.matcher(raw);
        while (matcher.find()) {
            String candidate = trimTrailingPunctuation(matcher.group());
            if (isAllowedSource(candidate)) return candidate;
        }
        return null;
    }

    private static String trimTrailingPunctuation(String value) {
        return value.replaceAll("[),.;]+$", "");
    }

    static boolean isAllowedSource(String raw) {
        try {
            URI uri = URI.create(raw);
            String host = uri.getHost();
            return "https".equalsIgnoreCase(uri.getScheme())
                    && host != null
                    && SOURCE_HOSTS.contains(host.toLowerCase(Locale.ROOT))
                    && uri.getRawUserInfo() == null
                    && (uri.getPort() == -1 || uri.getPort() == 443);
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    static String safeMediaUrl(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            URI uri = URI.create(raw.trim());
            String host = uri.getHost();
            String path = uri.getPath();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || path == null) return null;
            if (uri.getRawUserInfo() != null || (uri.getPort() != -1 && uri.getPort() != 443)) return null;
            if (!path.toLowerCase(Locale.ROOT).endsWith(".m3u8")) return null;
            if (isLocalOrPrivateHost(host)) return null;
            return uri.toString();
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    static boolean isLocalOrPrivateHost(String host) {
        if (host == null) return true;
        String h = host.toLowerCase(Locale.ROOT);
        if (h.equals("localhost") || h.equals("::1") || h.equals("0.0.0.0") || h.endsWith(".local")) return true;
        if (h.matches("^127\\.\\d+\\.\\d+\\.\\d+$")) return true;
        if (h.matches("^10\\.\\d+\\.\\d+\\.\\d+$")) return true;
        if (h.matches("^192\\.168\\.\\d+\\.\\d+$")) return true;
        Matcher m = Pattern.compile("^172\\.(\\d+)\\.\\d+\\.\\d+$").matcher(h);
        return m.matches() && Integer.parseInt(m.group(1)) >= 16 && Integer.parseInt(m.group(1)) <= 31;
    }

    private void captureCandidate(String raw, Map<String, String> requestHeaders) {
        String accepted = safeMediaUrl(raw);
        if (accepted == null || handedOff) return;
        Candidate candidate = Candidate.from(accepted, requestHeaders);
        synchronized (candidatesLock) {
            if (candidates.containsKey(accepted)) return;
            if (candidates.size() >= 24) return;
            candidates.put(accepted, candidate);
        }
        try {
            Log.i(TAG, "HLS candidate host=" + URI.create(accepted).getHost());
        } catch (RuntimeException ignored) {}
        mainHandler.post(() -> {
            setStatus("영상 주소를 찾았습니다. 가장 좋은 화질을 확인하고 있습니다…");
            updateAnalysisNotification("영상 주소를 찾았습니다 · 다운로드 준비 중");
            playButton.setVisibility(View.GONE);
            retryButton.setVisibility(View.GONE);
            if (!handoffScheduled) {
                handoffScheduled = true;
                mainHandler.postDelayed(handoffRunnable, HANDOFF_DELAY_MS);
            }
        });
    }

    private boolean hasCandidates() {
        synchronized (candidatesLock) {
            return !candidates.isEmpty();
        }
    }

    private Candidate bestCandidate() {
        List<Candidate> snapshot;
        synchronized (candidatesLock) {
            snapshot = new ArrayList<>(candidates.values());
        }
        Candidate best = null;
        int bestScore = Integer.MIN_VALUE;
        for (Candidate value : snapshot) {
            int score = qualityScore(value.url);
            if (best == null || score > bestScore) {
                best = value;
                bestScore = score;
            }
        }
        return best;
    }

    static int qualityScore(String value) {
        Matcher matcher = QUALITY.matcher(value == null ? "" : value);
        if (!matcher.find()) return 10;
        return switch (matcher.group(1).toLowerCase(Locale.ROOT)) {
            case "1920x1080", "1080p" -> 1080;
            case "1280x720", "720p" -> 720;
            case "842x480", "480p" -> 480;
            case "640x360", "360p" -> 360;
            default -> 10;
        };
    }

    private void injectCaptureBridge() {
        String script = "(function(){"
                + "if(window.__videoSaveCaptureV4)return;window.__videoSaveCaptureV4=true;"
                + "var send=function(v){try{if(v)CaptureBridge.candidate(String(v));}catch(e){}};"
                + "var hook=function(w){try{"
                + "var f=w.fetch;if(f){w.fetch=function(i,o){try{send(typeof i==='string'?i:(i&&i.url));}catch(e){}return f.apply(this,arguments);};}"
                + "var xo=w.XMLHttpRequest&&w.XMLHttpRequest.prototype.open;if(xo){w.XMLHttpRequest.prototype.open=function(m,u){send(u);return xo.apply(this,arguments);};}"
                + "}catch(e){}};"
                + "var scanWindow=function(w){try{hook(w);if(w.hls&&w.hls.url)send(w.hls.url);if(w.player&&w.player.hls&&w.player.hls.url)send(w.player.hls.url);"
                + "var vs=w.document&&w.document.querySelectorAll?w.document.querySelectorAll('video,source'):[];vs.forEach(function(v){send(v.currentSrc);send(v.src);try{if(v._hls&&v._hls.url)send(v._hls.url);}catch(e){}});}catch(e){}};"
                + "var scan=function(){try{scanWindow(window);document.querySelectorAll('iframe').forEach(function(f){try{scanWindow(f.contentWindow);}catch(e){}});performance.getEntriesByType('resource').forEach(function(e){send(e.name);});}catch(e){}};"
                + "scan();setInterval(scan,500);"
                + "})();";
        webView.evaluateJavascript(script, null);
    }

    private void softPrimePlayer() {
        if (handedOff || hasCandidates()) return;
        String js = "(function(){try{var v=document.querySelector('video');if(!v)return false;v.muted=true;v.playsInline=true;var p=v.play();if(p&&p.catch)p.catch(function(){});return true;}catch(e){return false;}})()";
        webView.evaluateJavascript(js, null);
        injectCaptureBridge();
    }

    private void triggerPlayback() {
        setStatus("영상을 재생하면서 주소를 찾고 있습니다…");
        String js = "(function(){try{"
                + "var v=document.querySelector('video');if(v){v.muted=true;v.playsInline=true;var p=v.play();if(p&&p.catch)p.catch(function(){});}"
                + "var sels=['.vjs-big-play-button','.plyr__control--overlaid','button[aria-label*=Play]','button[title*=Play]'];"
                + "for(var i=0;i<sels.length;i++){var b=document.querySelector(sels[i]);if(b){try{b.click();break;}catch(e){}}}"
                + "return !!v;}catch(e){return false;}})()";
        webView.evaluateJavascript(js, null);
        injectCaptureBridge();
    }

    private void retryCapture() {
        if (pageUrl == null) return;
        resetCapture();
        setStatus("다시 확인하고 있습니다…");
        updateAnalysisNotification("영상 주소를 다시 찾는 중입니다");
        mainHandler.postDelayed(timeoutRunnable, CAPTURE_TIMEOUT_MS);
        webView.reload();
    }

    private void resetCapture() {
        mainHandler.removeCallbacks(timeoutRunnable);
        mainHandler.removeCallbacks(handoffRunnable);
        synchronized (candidatesLock) {
            candidates.clear();
        }
        pendingDirectCandidate = null;
        handoffScheduled = false;
        handedOff = false;
    }

    private boolean notificationPermissionGranted() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestNotificationPermissionForStatus() {
        if (notificationPermissionGranted()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    private void startDirectDownload(Candidate candidate) {
        if (!notificationPermissionGranted()) {
            pendingDirectCandidate = candidate;
            setStatus("다운로드 진행률을 표시하려면 알림 권한을 허용해 주세요.");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
                return;
            }
        }
        startDirectDownloadNow(candidate, true);
    }

    private void startDirectDownloadNow(Candidate candidate, boolean canLeaveScreen) {
        String title = safeTitle();
        String cookie = CookieManager.getInstance().getCookie(candidate.url);
        Intent download = new Intent(this, HlsDownloadService.class)
                .putExtra(HlsDownloadService.EXTRA_STREAM, candidate.url)
                .putExtra(HlsDownloadService.EXTRA_PAGE, pageUrl == null ? "" : pageUrl)
                .putExtra(HlsDownloadService.EXTRA_TITLE, title)
                .putExtra(HlsDownloadService.EXTRA_COOKIE, cookie == null ? "" : cookie)
                .putExtra(HlsDownloadService.EXTRA_REFERER, candidate.referer)
                .putExtra(HlsDownloadService.EXTRA_ORIGIN, candidate.origin)
                .putExtra(HlsDownloadService.EXTRA_USER_AGENT, candidate.userAgent);
        try {
            notifications.cancel(ANALYSIS_NOTIFICATION_ID);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(download);
            else startService(download);
            CookieManager.getInstance().flush();
            setStatus("직접 다운로드를 시작했습니다. 상태 표시줄에서 진행률을 확인할 수 있습니다.");
            Toast.makeText(this, "다운로드 시작", Toast.LENGTH_LONG).show();
            if (canLeaveScreen) mainHandler.postDelayed(this::finish, 1_500L);
        } catch (RuntimeException error) {
            Log.e(TAG, "direct service start failed", error);
            handedOff = false;
            handoffScheduled = false;
            setStatus("휴대폰 다운로드를 시작하지 못해 서버 방식으로 전환합니다…");
            openDownloader(candidate.url);
        }
    }

    private void openDownloader(String stream) {
        String title = safeTitle();
        Uri target = Uri.parse(DOWNLOADER_URL).buildUpon()
                .appendQueryParameter("capture", "1")
                .appendQueryParameter("page", pageUrl == null ? "" : pageUrl)
                .appendQueryParameter("stream", stream)
                .appendQueryParameter("title", title)
                .build();
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, target));
            CookieManager.getInstance().flush();
            finish();
        } catch (ActivityNotFoundException ignored) {
            handedOff = false;
            handoffScheduled = false;
            setStatus("저장 화면을 열 수 없습니다. 브라우저를 확인해 주세요.");
            retryButton.setVisibility(View.VISIBLE);
        }
    }

    private void ensureAnalysisChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    ANALYSIS_CHANNEL_ID,
                    "영상 분석",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("영상 주소를 찾는 진행 상태");
            notifications.createNotificationChannel(channel);
        }
    }

    private void updateAnalysisNotification(String text) {
        if (!notificationPermissionGranted() || notifications == null) return;
        Intent open = new Intent(this, CaptureActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 4106, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, ANALYSIS_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("영상 저장 도구")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(content)
                .build();
        notifications.notify(ANALYSIS_NOTIFICATION_ID, notification);
    }

    private String safeTitle() {
        String title = webView.getTitle();
        if (title == null || title.isBlank()) return "NJAVTV 영상";
        title = title.replaceAll("[\\r\\n]+", " ").trim();
        return title.length() > 180 ? title.substring(0, 180) : title;
    }

    private static boolean looksLikeChallenge(String title, String url) {
        String value = ((title == null ? "" : title) + " " + (url == null ? "" : url)).toLowerCase(Locale.ROOT);
        return value.contains("잠시만") || value.contains("just a moment") || value.contains("challenge") || value.contains("verify");
    }

    private void setStatus(String message) {
        if (Looper.myLooper() == Looper.getMainLooper()) statusView.setText(message);
        else mainHandler.post(() -> statusView.setText(message));
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private final class CaptureBridge {
        @JavascriptInterface
        public void candidate(String value) {
            captureCandidate(value, Map.of());
        }
    }

    private record Candidate(String url, String referer, String origin, String userAgent) {
        static Candidate from(String url, Map<String, String> headers) {
            String referer = header(headers, "Referer");
            String origin = header(headers, "Origin");
            String userAgent = header(headers, "User-Agent");
            return new Candidate(url, referer, origin, userAgent);
        }

        private static String header(Map<String, String> headers, String name) {
            if (headers == null) return "";
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                if (entry.getKey() != null && entry.getKey().equalsIgnoreCase(name)) {
                    return entry.getValue() == null ? "" : entry.getValue();
                }
            }
            return "";
        }
    }
}
