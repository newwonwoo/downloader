package com.newwonwoo.videosavetool;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import org.json.JSONTokener;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final String DOWNLOADER_URL = "https://downloader-web-1gqu.onrender.com";
    private static final Pattern NJAV_URL = Pattern.compile("https://(?:www\\.)?njavtv\\.com/[^\\s<>\\\"]+", Pattern.CASE_INSENSITIVE);
    private static final int MAX_POLLS = 40;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private TextView status;
    private String sourceUrl;
    private boolean handedOff = false;
    private int pollCount = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handedOff = false;
        pollCount = 0;
        handler.removeCallbacksAndMessages(null);
        handleIntent(intent);
    }

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        status = new TextView(this);

        FrameLayout.LayoutParams webParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        );
        root.addView(webView, webParams);

        status.setTextColor(Color.WHITE);
        status.setTextSize(16f);
        status.setGravity(Gravity.CENTER_VERTICAL);
        status.setPadding(dp(18), dp(12), dp(18), dp(12));
        status.setBackgroundColor(Color.argb(225, 15, 23, 42));
        FrameLayout.LayoutParams statusParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(64),
                Gravity.TOP
        );
        root.addView(status, statusParams);
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                inspectCandidate(request.getUrl().toString());
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
                if (host.equals("njavtv.com") || host.equals("www.njavtv.com")) return false;
                return request.isForMainFrame();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (!handedOff) {
                    status.setText("영상 재생 주소를 찾는 중입니다…");
                    startPolling();
                }
            }
        });
    }

    private void handleIntent(Intent intent) {
        String shared = null;
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            shared = intent.getStringExtra(Intent.EXTRA_TEXT);
        }
        sourceUrl = extractNjavUrl(shared);
        if (sourceUrl == null) {
            status.setText("NJAVTV 영상에서 공유 → 영상 저장 도구를 선택해 주세요.");
            webView.loadUrl(DOWNLOADER_URL);
            return;
        }
        status.setText("영상을 찾고 있습니다. 보안 확인이 보이면 완료해 주세요.");
        webView.loadUrl(sourceUrl);
    }

    private String extractNjavUrl(String text) {
        if (text == null) return null;
        Matcher matcher = NJAV_URL.matcher(text);
        if (!matcher.find()) return null;
        String value = matcher.group();
        while (value.endsWith(")") || value.endsWith(",") || value.endsWith(".")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private void inspectCandidate(String candidate) {
        if (candidate == null || !candidate.toLowerCase(Locale.ROOT).contains(".m3u8")) return;
        try {
            Uri uri = Uri.parse(candidate);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            if (!(host.equals("surrit.com") || host.endsWith(".surrit.com") ||
                    host.equals("nineyu.com") || host.endsWith(".nineyu.com"))) return;
            runOnUiThread(() -> handoff(candidate));
        } catch (Exception ignored) {
        }
    }

    private void startPolling() {
        handler.removeCallbacks(pollRunnable);
        handler.post(pollRunnable);
    }

    private final Runnable pollRunnable = new Runnable() {
        @Override
        public void run() {
            if (handedOff || webView == null) return;
            pollCount++;
            String script = "(() => {" +
                    "if(window.hls&&window.hls.url)return window.hls.url;" +
                    "for(const v of document.querySelectorAll('video')){" +
                    "if(v._hls&&v._hls.url)return v._hls.url;" +
                    "if(/\\.m3u8(?:\\?|$)/i.test(v.currentSrc||''))return v.currentSrc;" +
                    "if(/\\.m3u8(?:\\?|$)/i.test(v.src||''))return v.src;" +
                    "}" +
                    "const a=performance.getEntriesByType('resource').map(e=>e.name).filter(x=>/\\.m3u8(?:\\?|$)/i.test(x));" +
                    "return a[a.length-1]||'';" +
                    "})()";
            webView.evaluateJavascript(script, value -> {
                try {
                    Object decoded = new JSONTokener(value).nextValue();
                    if (decoded instanceof String) inspectCandidate((String) decoded);
                } catch (Exception ignored) {
                }
            });

            if (pollCount == 4) {
                webView.evaluateJavascript("document.querySelector('video')?.play()?.catch(()=>{})", null);
            }
            if (!handedOff && pollCount < MAX_POLLS) {
                handler.postDelayed(this, 1000);
            } else if (!handedOff) {
                status.setText("영상이 보이면 재생 버튼을 한 번 눌러 주세요.");
                pollCount = 0;
                handler.postDelayed(this, 1000);
            }
        }
    };

    private void handoff(String hlsUrl) {
        if (handedOff || hlsUrl == null || hlsUrl.isEmpty()) return;
        handedOff = true;
        handler.removeCallbacks(pollRunnable);
        status.setText("영상 주소를 찾았습니다. 저장 화면으로 이동합니다.");

        String title = webView.getTitle();
        if (title == null || title.trim().isEmpty()) title = "NJAVTV 영상";
        String fragment = "hls=" + Uri.encode(hlsUrl) +
                "&title=" + Uri.encode(title) +
                "&source=" + Uri.encode(sourceUrl == null ? "" : sourceUrl);
        Uri target = Uri.parse(DOWNLOADER_URL + "/#" + fragment);
        Intent open = new Intent(Intent.ACTION_VIEW, target);
        startActivity(open);
        finish();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
