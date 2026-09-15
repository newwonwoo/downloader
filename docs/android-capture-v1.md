# Android Capture v1

## Decision

The current architecture cannot reliably resolve every NJAVTV page from a cloud server because the source can return Cloudflare challenge/403 responses to Render and other datacenter IPs. A PWA share target only receives the shared URL; it cannot inspect the source Samsung Internet tab's DOM or network requests.

The new architecture therefore moves *media discovery* onto the user's Android device and keeps the existing Render worker for MP4 preparation/download.

## Target UX

One-time setup: install `영상 저장 도구` Android app.

Normal flow:

1. Open the NJAVTV video in Samsung Internet.
2. Tap Share -> `영상 저장 도구`.
3. The capture app opens the shared page in an in-app WebView using the user's device/network.
4. The app detects the first valid HLS manifest automatically.
5. It hands the captured manifest + page title back to the existing downloader UI.
6. Existing file-job worker prepares MP4 and the user saves it.

Expected normal interaction after install: Share -> 영상 저장 도구. No bookmark, URL editing, clipboard step, or server-side page resolver.

If the source shows a challenge page, the WebView remains visible so the user can complete it once. Detection then continues automatically.

## Components

### 1. Android capture app

A small native Android app, separate from the PWA but in the same repository.

Responsibilities:
- Register `ACTION_SEND` for `text/plain` so it appears in Samsung Internet's Android share sheet.
- Extract and validate only `https://njavtv.com/...` URLs from `Intent.EXTRA_TEXT` / subject text.
- Open the URL in WebView with JavaScript, DOM storage, cookies, third-party cookies, and media playback enabled.
- Persist WebView cookies so repeat captures reuse any challenge/session state.
- Never perform TLS MITM, VPN interception, accessibility scraping, or device-wide traffic capture.

### 2. Multi-layer HLS capture

Capture only allow-listed media hosts (`surrit.com`, `nineyu.com`) and only `.m3u8` URLs.

Layer A — `WebViewClient.shouldInterceptRequest`:
- Observe normal HTTP(S) subresource requests.
- Return `null`; never replace the response.

Layer B — `ServiceWorkerClient.shouldInterceptRequest` on API 24+:
- Observe resource requests made through a page service worker.
- Return `null`.

Layer C — injected JavaScript bridge:
- Wrap `window.fetch` and `XMLHttpRequest.open`.
- Inspect `video.currentSrc`, `video.src`, `<source src>`, and `performance.getEntriesByType('resource')`.
- Send candidate URLs through an `@JavascriptInterface` bridge.

A candidate is accepted only when:
- scheme is HTTPS;
- host equals or is a subdomain of an allow-listed media suffix;
- pathname ends in `.m3u8` (query string allowed).

First valid candidate wins initially; duplicates are ignored. Keep up to 12 candidates for quality selection if multiple manifests are observed.

### 3. Capture state machine

`RECEIVED_SHARE -> LOADING_PAGE -> WATCHING_NETWORK -> CAPTURED -> HANDOFF`

Fallback states:
- `CHALLENGE`: source page/title/content indicates challenge; keep WebView visible and wait for user completion.
- `WAITING_FOR_PLAY`: no manifest after initial load; show one clear button: `영상 재생` and continue watching.
- `TIMEOUT`: no valid HLS after 45 seconds of active page time; show retry and preserve the page.

Do not show raw stack traces/curl/HTTP internals to the user.

## Handoff contract

Add a direct-media handoff endpoint to the existing web app instead of re-running `/resolve`.

Preferred URL shape:

`https://downloader-web-1gqu.onrender.com/?capture=1&page=<encoded page>&stream=<encoded m3u8>&title=<encoded title>`

Frontend behavior when `capture=1`:
- validate `stream` against the same media-host allow-list;
- bypass `/resolve` completely;
- create the standard result model with the captured stream;
- allow existing file-job flow to prepare MP4.

This prevents a successfully captured manifest from being sent back through the server-side source-page resolver that caused the 409 problem.

## Existing backend

Keep:
- current Render static frontend;
- current Python worker;
- `/jobs` queue/recovery;
- adaptive HLS concurrency;
- MP4 remux pipeline.

Remove from the primary user path:
- server-side NJAVTV page resolution;
- browser-resolver experiments;
- bookmarklet workflow.

`/resolve` remains only as a legacy/fallback diagnostic path until the Android capture flow is proven.

## Security boundaries

- Source URLs: only `njavtv.com` / `www.njavtv.com`.
- Media URLs: only HTTPS on `surrit.com` / `nineyu.com` suffixes.
- Do not expose arbitrary URL proxying.
- Do not enable universal file URL access in WebView.
- Disable file/content access unless needed.
- No device-wide packet inspection.
- No background capture of unrelated tabs/apps.

## Acceptance criteria

For `https://njavtv.com/dm2/ko/ktkp-001-uncensored-leak` on Samsung Internet mobile:

1. Share sheet contains `영상 저장 도구` after installation.
2. Selecting it launches capture without copy/paste/bookmarks.
3. If a challenge appears, the user can complete it in the app and capture resumes automatically.
4. A valid allow-listed `.m3u8` is captured from the actual device session.
5. The web downloader opens with the captured stream and does **not** call `/resolve` for the page.
6. MP4 file job completes using the existing worker.
7. No raw 409/500/curl error text is shown in the normal UI.

## Delivery plan

Parallel implementation tracks:

- Track A: Android share target + WebView + network/JS capture.
- Track B: frontend `capture=1` direct-media handoff + validation + UI state cleanup.
- Track C: Android CI build artifact + contract tests + regression tests for existing web/worker.

Merge only after all three tracks pass. Production web/worker deployment remains unchanged until Track B is merged. Android output is distributed as a debug/test APK first; signing/distribution is a separate release concern.
