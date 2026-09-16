# Android Downloader v2 — final audit

Date: 2026-09-17

## Decision

The Android v2 branch is now suitable to merge as the operational baseline. The previous failure was not an APK build failure: the old runtime gate could not distinguish an app failure from an external page/DNS failure, and later also checked the Activity UI after the Activity had already handed the job to the background service and finished.

The current branch fixes those test-design errors and has now passed the Android 15 build/runtime gate against the exact reported page.

This decision does **not** mean every long-download/recovery scenario is proven. The remaining limits are listed explicitly below.

## Reported case

- Shared page: `https://njavtv.com/ko/dvaj-041-uncensored-leak`
- Original symptom: capture remained in a searching state and useful download progress did not appear.

## Verified on the final v2 branch

### Build and identity

- The launcher/share activity is `CaptureActivity`; stale `MainActivity` is absent.
- JVM tests pass.
- Debug APK builds with API 35 tooling.
- The built APK manifest is inspected for ACTION_SEND, notification permission, `HlsDownloadService`, and `dataSync` foreground-service declaration.
- APK signature verification passes.
- Dev builds use one stable, explicitly non-production signing identity so subsequent dev APKs can update the previous dev build.
- The UI displays `versionName/versionCode`, short Git SHA, and `dev` build identity; Android runtime CI checks those values before starting the reported share flow.

### Capture and real target runtime

Android 15 emulator runtime testing now launches the actual APK and sends the exact reported URL through ACTION_SEND.

On the final green branch run the app:

1. opened the reported NJAVTV page,
2. observed an HLS candidate on `surrit.com`,
3. handed it to `HlsDownloadService`,
4. resolved and validated the media playlist,
5. reported `stream validated segments=1777`,
6. kept the package notification/background transfer state after the capture Activity was left.

The runtime result is recorded as `TARGET_CAPTURE=stream_validated`.

The runtime gate also distinguishes external page/DNS/challenge failure from an application failure. A future `ERR_NAME_NOT_RESOLVED`, connection failure, or challenge page is recorded as an external target state rather than falsely failing the APK itself.

### Capture reliability improvements

- Capture is no longer restricted to a fixed CDN hostname allowlist.
- HLS discovery accepts `.m3u8` plus manifest/playlist/master path hints and HLS query hints while retaining external-HTTPS/private-host safety checks.
- WebResourceRequest headers, Referer, Origin, User-Agent, cookies, Service Worker requests, fetch/XHR observation, video/source URLs, and Resource Timing candidates are used as capture inputs.
- Main-frame WebView failures now show/log the actual connection reason instead of leaving only a generic searching message.
- Direct handoff no longer claims a completed download before the service has validated the stream.

### Downloader behavior

- The foreground service starts immediately with a user-visible "stream connection check" phase.
- The playlist must resolve and contain segments before progress is reported as a validated download.
- Master playlists choose the best available variant by resolution/bandwidth.
- AES-128, byte ranges, TS remux, fragmented MP4 joining, MediaStore save, retry/backoff, and external-HTTPS/private-host checks remain covered by source/JVM contract tests.
- A killed/restarted service requests intent redelivery with `START_REDELIVER_INTENT`, so the job can restart with the original request context instead of being silently lost.
- DNS, timeout, authorization/expiry, and unsupported-HLS failures have explicit user-facing failure messages.

## Problems from the previous design that are now closed

1. **CI checked the wrong Activity** — closed. CI validates `CaptureActivity` and rejects stale `MainActivity`.
2. **Build success was treated as runtime success** — closed. CI installs and exercises the APK on Android 15.
3. **Debug signing changed between builds** — closed for dev builds with a stable non-production key.
4. **Capture gate depended on two CDN names + `.m3u8` suffix** — closed for the current HLS discovery path.
5. **Page/DNS failure looked like an app failure** — closed in runtime classification and user-visible error handling.
6. **No build identity on device** — closed; version/code/Git SHA/flavor are visible and CI-checked.
7. **Background handoff was not exercised** — closed for the current foreground-service baseline; the exact target reached stream validation and retained notification/background state.

## Known limits — not hidden by the merge decision

### 1. CI does not wait for the entire 1,777-segment target video to finish

The exact real target is proven through page capture, HLS discovery, service handoff, playlist validation, segment-count resolution, and background notification state. The CI observation window intentionally does not download the entire large video and then open the resulting MP4.

Therefore the final large-file `MediaStore -> playable MP4` completion of this specific target is **not** claimed as CI-proven.

### 2. A deterministic tiny HLS fixture is still desirable

A self-contained fixture that verifies:

`playlist -> segments -> decrypt if needed -> remux/join -> MP4 -> playable audio/video tracks`

would separate downloader correctness from the behavior of an external site. Current JVM tests cover parser/selection/safety behavior, while the real-target smoke proves actual capture and stream validation.

### 3. Interruption recovery restarts the job; it does not resume from the last completed segment

`START_REDELIVER_INTENT` prevents silent job loss after service recreation, but the current downloader does not persist a per-segment checkpoint. A restarted long download may begin again from the start.

### 4. Android 14+ still uses the foreground-service compatibility baseline

The current implementation uses a `dataSync` foreground service. A future hardening pass can move Android 14+ long user-triggered transfers to User-Initiated Data Transfer JobScheduler while retaining the current path as compatibility behavior.

### 5. The checked-in signing identity is dev-only

It exists solely to make test APK updates deterministic. It is not a production release-signing design and must not be treated as one.

## Merge gate result

The branch now passes the gates required for the operational v2 baseline:

- correct Activity/manifest validation,
- JVM tests,
- APK build,
- fixed dev certificate verification,
- visible build identity,
- Android 15 installation/cold start,
- exact ACTION_SEND reported URL,
- real HLS candidate observation,
- real playlist/segment validation,
- foreground/background notification state,
- explicit separation of external target failure from app failure.

The remaining items above are hardening and release-engineering work. They are deliberately not described as completed.