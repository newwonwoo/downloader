# Android Downloader v2 — clean-room audit

## Scope

This audit treats the current Android downloader as untrusted. It does not assume that a successful compile, APK build, or source grep proves the user flow works.

Primary reported case:

- Shared page: `https://njavtv.com/ko/dvaj-041-uncensored-leak`
- Observed symptom: capture screen remains in a trying/searching state and no useful download progress appears.

## Evidence from the clean test harness

### What now passes

- The actual launcher/share activity in the built APK is `CaptureActivity`.
- The APK builds on API 35 tooling.
- The built APK manifest contains the share intent, notification permission, and the dataSync foreground service declaration.
- Android 15 emulator installation and cold start through the exact ACTION_SEND URL work without an app crash.

### What does not work in the reported flow

On an Android 15 emulator, after the exact reported URL is shared into the actual APK, the app remains in the capture phase. It never reaches `HlsDownloadService`.

The UI remains at:

`영상 주소를 찾는 중입니다. 자동 재생도 시도합니다…`

with `영상 재생` and `다시 시도` still visible.

The emulator later exposes the WebView error page with:

`net::ERR_NAME_NOT_RESOLVED`

for `njavtv.com`.

This means the emulator cannot be used as proof that NJAVTV itself is capturable in that environment. It *does* prove that the previous testing strategy was insufficient and that the app currently has no deterministic success path when page loading/capture fails.

## Problems found in the current v1.2 design

### 1. Previous CI checked the wrong Activity

The production manifest launches `CaptureActivity`, but the previous CI contract checks were still grepping `MainActivity.java`. A successful CI run therefore did not validate the code the user actually launched.

### 2. Build success was presented as runtime success

The old Android workflow compiled an APK and checked that a file existed. It did not install the APK on Android and exercise the share flow, notification, background execution, or MediaStore save path.

### 3. Debug APK signing was not stable

The previously distributed debug APKs were signed by different generated debug certificates. A newer APK therefore cannot reliably update an older APK in place. This makes it possible to believe v1.2 is installed while the device is actually still running an older build unless the older app is uninstalled first.

A future test build must have a stable, explicitly non-production signing identity and must display its version/build id in the UI.

### 4. The capture gate is too narrow

`CaptureActivity` only accepts media URLs when both conditions are true:

- host ends in `surrit.com` or `nineyu.com`
- URL path ends in `.m3u8`

If NJAVTV changes CDN, uses a tokenized endpoint without an `.m3u8` suffix, or changes the player request shape, the app silently waits forever even if playable HLS is present.

### 5. The Samsung Internet session is not transferred into WebView

Sharing a page URL transfers the URL, not the browser's cookie/session/network state. The app then opens NJAVTV in its own WebView cookie jar. A page that succeeded in Samsung Internet may therefore challenge or fail inside WebView.

The design must treat page/session establishment as a first-class state instead of assuming that receiving the URL is enough.

### 6. Exact request context is discarded

When a stream is observed, the app passes mostly the stream URL, page URL, title, and a cookie string to the download service. The service then reconstructs generic User-Agent, Referer, and Origin headers.

For anti-hotlink/CDN requests this is fragile. The capture stage should preserve the request headers and cookies that were actually associated with the observed media request and verify access before declaring capture successful.

### 7. No preflight before "download started"

The app starts the background service as soon as a candidate URL is found. It does not first prove that the playlist and at least one media segment are readable with the captured request context.

A candidate is not a successful capture until playlist + first-segment preflight succeeds.

### 8. Download lifecycle should use the Android transfer primitive designed for this case

For Android 14+, a user-triggered long download maps directly to a User-Initiated Data Transfer Job. Android documents UIDT specifically for user-started downloads and requires a user-visible notification. The current raw `dataSync` foreground service can remain only as a compatibility fallback for older Android versions.

### 9. The direct downloader is not yet deterministic-testable end to end

The current tests do not provide a known local HLS fixture and verify:

`playlist -> segments -> decrypt if needed -> remux -> valid MP4 -> MediaStore`

Without this, changes to capture and changes to the downloader remain entangled.

## v2 architecture

### Stage A — Session / page

State machine:

1. `OPENING_PAGE`
2. `PAGE_READY`
3. `SECURITY_CHECK_REQUIRED` or `PAGE_LOAD_FAILED`
4. `SEARCHING_MEDIA`
5. `MEDIA_CANDIDATE`
6. `MEDIA_PREFLIGHT`
7. `READY_TO_DOWNLOAD`

The UI must show the current state and a concrete failure reason. No indefinite generic "trying" state.

Keep one persistent WebView profile for NJAVTV so a user-completed challenge/session can be reused on later shares.

### Stage B — Generic media discovery

Do not use a fixed CDN allowlist as the primary detector.

Collect candidates from:

- `WebResourceRequest` including its request headers
- Service Worker requests
- JS `fetch` / XHR observation
- `video.currentSrc`, `source.src`, Resource Timing entries

Score a candidate using URL/path/query/initiator clues, but confirm it by a bounded preflight. A candidate observed from the active page can be accepted when its response body identifies an HLS playlist (`#EXTM3U`), even if the path is not named `.m3u8`.

Security rule: only preflight/download media origins that were actually observed from the active page session. Do not turn the app into an arbitrary URL proxy/downloader.

### Stage C — Capture exact request context

For the accepted playlist persist a sanitized request context:

- URL
- observed request headers needed by the CDN
- WebView User-Agent
- relevant cookies for that host
- referring page

Before moving to download, fetch the playlist and first segment with that context. If either fails, stay in capture with a specific status such as `403 from media host`, `timeout`, or `playlist format not supported`.

### Stage D — Background download

- Android 14+: `JobScheduler` User-Initiated Data Transfer job.
- Android 8–13: foreground-service compatibility path.
- Persistent job state so process death can resume/retry.
- Pooled HTTP client; bounded adaptive concurrency.
- Notification with progress, current phase, cancel action, and retry/failure state.
- TS playlists: direct on-device remux to MP4.
- fMP4/other formats: explicit supported path or explicit server-remux fallback after media preflight; never silently change mode.

### Stage E — Trustworthy build identity

Every test APK must show at least:

- versionName/versionCode
- short Git SHA
- build flavor (`dev`)

Dev APKs need one stable non-production signing identity so a newer dev build reliably upgrades the previous dev build.

## Acceptance gates before another APK is called "ready"

1. CI validates `CaptureActivity`, not stale `MainActivity`.
2. Built APK manifest is inspected, not just source XML.
3. APK installs and handles ACTION_SEND on Android 15 without crash.
4. Exact reported URL test records the real terminal capture state; DNS/Cloudflare failure is reported as such rather than called success.
5. Deterministic local HLS fixture test completes the full download pipeline and produces a playable MP4 with audio/video tracks.
6. Background transfer remains active after the Activity is left.
7. A progress notification appears when notification permission is granted.
8. Process interruption/resume is tested.
9. Stable dev signing/update test passes (`adb install -r` old dev APK -> new dev APK).
10. UI visibly reports version/build id.

## Decision

Do not distribute another APK from the current v1.2 design as "fixed". Keep main unchanged while v2 is rebuilt on `rebuild/android-downloader-v2`. Merge only after the capture stage and deterministic download stage pass independently and together.
