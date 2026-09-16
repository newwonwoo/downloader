package com.newwonwoo.downloader.capture;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
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
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class CaptureActivity extends Activity {
    private static final String DOWNLOADER_URL = "https://downloader-web-1gqu.onrender.com/";
    private static final Set<String> SOURCE_HOSTS = Set.of("njavtv.com", "www.njavtv.com");
    private static final List<String> MEDIA_SUFFIXES = List.of("surrit.com", "nineyu.com");
    private static final Pattern SHARED_URL = Pattern.compile("https://(?:www\\.)?njavtv\\.com/[^\\s<>\\\"']+", Pattern.CASE_INSENSITIVE);
    private static final Pattern QUALITY = Pattern.compile("/(1920x1080|1280x720|842x480|640x360|1080p|720p|480p|360p)/", Pattern.CASE_INSENSITIVE);
    private static final long CAPTURE_TIMEOUT_MS = 45_000L;
    private static final long HANDOFF_DELAY_MS = 1_200L;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4108;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object candidatesLock = new Object();
    private final LinkedHashSet<String> candidates = new LinkedHashSet<>();

    private WebView webView;
    private TextView statusView;
    private Button playButton;
    private Button retryButton;
    private String pageUrl;
    private String pendingDirectStream;
    private boolean handoffScheduled;
    private boolean handedOff;
    private boolean autoPlayScheduled;

    private final Runnable timeoutRunnable = () -> {
        if (handedOff || hasCandidates()) return;
        setStatus("영상 주소를 아직 찾지 못했습니다. 아래 '영상 재생'을 눌러 주세요.");
        playButton.setVisibility(View.VISIBLE);
        retryButton.setVisibility(View.VISIBLE);
    };

    private final Runnable handoffRunnable = () -> {
        if (handedOff) return;
        String stream = bestCandidate();
        if (stream == null) {
            handoffScheduled = false;
            return;
        }
        handedOff = true;
        mainHandler.removeCallbacks(timeoutRunnable);
        startDirectDownload(stream);
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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
        String stream = pendingDirectStream;
        pendingDirectStream = null;
        if (stream == null) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            startDirectDownloadNow(stream, true);
        } else {
            setStatus("알림 권한이 꺼져 있습니다. 다운로드는 시작하지만 진행 상황은 이 화면에서만 확인할 수 있습니다.");
            startDirectDownloadNow(stream, false);
        }
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
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
        statusView.setPadding(dp(16), dp(14), dp(16), dp(14));
        statusView.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(statusView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(dp(12), 0, dp(12), dp(8));

        playButton = new Button(this);
        playButton.setText("영상 재생");
        playButton.setVisibility(View.GONE);
        playButton.setOnClickListener(v -> triggerPlayback(true));
        actions.addView(playButton, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        retryButton = new Button(this);
        retryButton.setText("다시 시도");
        retryButton.setVisibility(View.GONE);
        retryButton.setOnClickListener(v -> retryCapture());
        actions.addView(retryButton, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        root.addView(actions, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        webView = new WebView(this);
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
                if (request != null && request.getUrl() != null) captureCandidate(request.getUrl().toString());
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
                String title = safeTitle();
                if (looksLikeChallenge(title, url)) {
                    setStatus("보안 확인이 보이면 완료해 주세요. 완료 후 자동으로 영상을 찾습니다.");
                    playButton.setVisibility(View.VISIBLE);
                    return;
                }
                if (!hasCandidates()) {
                    setStatus("영상 주소를 찾는 중입니다. 자동 재생도 시도합니다…");
                    playButton.setVisibility(View.VISIBLE);
                    scheduleAutoPlayback();
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
                    if (request != null && request.getUrl() != null) captureCandidate(request.getUrl().toString());
                    return null;
                }
            });
        } catch (Throwable ignored) {
            // WebView interception and JS observation remain active.
        }
    }

    private void handleIntent(Intent intent) {
        String source = extractSourceUrl(extractSharedText(intent));
        if (source == null) {
            setStatus("NJAVTV 영상에서 공유 → 영상 저장 도구를 선택해 주세요.");
            playButton.setVisibility(View.GONE);
            retryButton.setVisibility(View.GONE);
            return;
        }
        pageUrl = source;
        setStatus("공유된 영상을 확인하고 있습니다…");
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
                    && uri.getRawUserInfo() == null;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    static String allowedMedia(String raw) {
        try {
            URI uri = URI.create(raw);
            String host = uri.getHost();
            String path = uri.getPath();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || path == null || uri.getRawUserInfo() != null) return null;
            String normalizedHost = host.toLowerCase(Locale.ROOT);
            boolean hostAllowed = false;
            for (String suffix : MEDIA_SUFFIXES) {
                if (normalizedHost.equals(suffix) || normalizedHost.endsWith("." + suffix)) {
                    hostAllowed = true;
                    break;
                }
            }
            if (!hostAllowed || !path.toLowerCase(Locale.ROOT).endsWith(".m3u8")) return null;
            return uri.toString();
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private void captureCandidate(String raw) {
        String accepted = allowedMedia(raw);
        if (accepted == null || handedOff) return;
        boolean added;
        synchronized (candidatesLock) {
            if (candidates.size() >= 16 || candidates.contains(accepted)) return;
            added = candidates.add(accepted);
        }
        if (!added) return;
        mainHandler.post(() -> {
            setStatus("영상 주소를 찾았습니다. 직접 다운로드를 준비합니다…");
            playButton.setVisibility(View.GONE);
            retryButton.setVisibility(View.GONE);
            if (!handoffScheduled) {
                handoffScheduled = true;
                mainHandler.postDelayed(handoffRunnable, HANDOFF_DELAY_MS);
            }
        });
    }

    private boolean hasCandidates() {
        synchronized (candidatesLock) { return !candidates.isEmpty(); }
    }

    private String bestCandidate() {
        List<String> snapshot;
        synchronized (candidatesLock) { snapshot = new ArrayList<>(candidates); }
        String best = null;
        int bestScore = Integer.MIN_VALUE;
        for (String value : snapshot) {
            int score = qualityScore(value);
            if (best == null || score > bestScore) {
                best = value;
                bestScore = score;
            }
        }
        return best;
    }

    private static int qualityScore(String value) {
        Matcher matcher = QUALITY.matcher(value == null ? "" : value);
        if (!matcher.find()) return 1;
        return switch (matcher.group(1).toLowerCase(Locale.ROOT)) {
            case "1920x1080", "1080p" -> 1080;
            case "1280x720", "720p" -> 720;
            case "842x480", "480p" -> 480;
            case "640x360", "360p" -> 360;
            default -> 1;
        };
    }

    private void injectCaptureBridge() {
        String script = "(function(){"
                + "if(window.__captureV2)return;window.__captureV2=true;"
                + "var send=function(v){try{if(v)CaptureBridge.candidate(String(v));}catch(e){}};"
                + "var of=window.fetch;if(of){window.fetch=function(i,o){try{send(typeof i==='string'?i:(i&&i.url));}catch(e){}return of.apply(this,arguments);};}"
                + "var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){send(u);return xo.apply(this,arguments);};"
                + "var scan=function(){try{document.querySelectorAll('video,source').forEach(function(v){send(v.currentSrc);send(v.src);});performance.getEntriesByType('resource').forEach(function(e){send(e.name);});}catch(e){}};"
                + "scan();setInterval(scan,700);"
                + "})();";
        webView.evaluateJavascript(script, null);
    }

    private void scheduleAutoPlayback() {
        if (autoPlayScheduled) return;
        autoPlayScheduled = true;
        long[] delays = {500L, 2_000L, 5_000L, 10_000L};
        for (long delay : delays) {
            mainHandler.postDelayed(() -> {
                if (!handedOff && !hasCandidates()) triggerPlayback(false);
            }, delay);
        }
    }

    private void triggerPlayback(boolean userInitiated) {
        if (userInitiated) setStatus("영상을 재생하면서 주소를 찾고 있습니다…");
        String js = "(function(){try{"
                + "var v=document.querySelector('video');if(v){v.muted=true;v.playsInline=true;var p=v.play();if(p&&p.catch)p.catch(function(){});v.click();}"
                + "var sels=['.vjs-big-play-button','.plyr__control--overlaid','button[aria-label*=Play]','button[title*=Play]'];"
                + "for(var i=0;i<sels.length;i++){var b=document.querySelector(sels[i]);if(b){try{b.click();}catch(e){}}}"
                + "return !!v;}catch(e){return false;}})()";
        webView.evaluateJavascript(js, null);
        injectCaptureBridge();
    }

    private void retryCapture() {
        if (pageUrl == null) return;
        resetCapture();
        setStatus("다시 확인하고 있습니다…");
        mainHandler.postDelayed(timeoutRunnable, CAPTURE_TIMEOUT_MS);
        webView.reload();
    }

    private void resetCapture() {
        mainHandler.removeCallbacks(timeoutRunnable);
        mainHandler.removeCallbacks(handoffRunnable);
        synchronized (candidatesLock) { candidates.clear(); }
        pendingDirectStream = null;
        handoffScheduled = false;
        handedOff = false;
        autoPlayScheduled = false;
    }

    private boolean notificationPermissionGranted() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void startDirectDownload(String stream) {
        if (!notificationPermissionGranted()) {
            pendingDirectStream = stream;
            setStatus("다운로드 진행률을 표시하려면 알림 권한을 허용해 주세요.");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
                return;
            }
        }
        startDirectDownloadNow(stream, true);
    }

    private void startDirectDownloadNow(String stream, boolean canLeaveScreen) {
        String title = safeTitle();
        String cookie = CookieManager.getInstance().getCookie(stream);
        Intent download = new Intent(this, HlsDownloadService.class)
                .putExtra(HlsDownloadService.EXTRA_STREAM, stream)
                .putExtra(HlsDownloadService.EXTRA_PAGE, pageUrl == null ? "" : pageUrl)
                .putExtra(HlsDownloadService.EXTRA_TITLE, title)
                .putExtra(HlsDownloadService.EXTRA_COOKIE, cookie == null ? "" : cookie);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(download);
            else startService(download);
            CookieManager.getInstance().flush();
            playButton.setVisibility(View.GONE);
            retryButton.setVisibility(View.GONE);
            if (canLeaveScreen) {
                setStatus("직접 다운로드를 시작했습니다. 상태 표시줄 알림에서 진행률을 확인할 수 있습니다.");
                Toast.makeText(this, "다운로드 시작 · 다른 화면으로 이동해도 계속됩니다.", Toast.LENGTH_LONG).show();
                mainHandler.postDelayed(this::finish, 1_800L);
            } else {
                setStatus("직접 다운로드를 시작했습니다. 알림 권한이 없어 이 화면을 열어 두는 것을 권장합니다.");
            }
        } catch (RuntimeException error) {
            handedOff = false;
            handoffScheduled = false;
            setStatus("휴대폰 직접 다운로드를 시작하지 못해 서버 방식으로 전환합니다…");
            openDownloader(stream);
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
        public void candidate(String value) { captureCandidate(value); }
    }
}
