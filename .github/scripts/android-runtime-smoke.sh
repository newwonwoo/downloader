#!/usr/bin/env bash
set -euo pipefail

PKG=com.newwonwoo.downloader.capture
APK=$(find /tmp/apk -name '*.apk' -print -quit)
test -n "$APK"

adb install -r "$APK"
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS
adb logcat -c

echo '--- exact user URL share-intent smoke ---'
adb shell am force-stop "$PKG"
adb shell am start -W \
  -a android.intent.action.SEND \
  -t text/plain \
  --es android.intent.extra.TEXT 'https://njavtv.com/ko/dvaj-041-uncensored-leak' \
  -n "$PKG/.CaptureActivity"
sleep 15

snapshot() {
  local label="$1"
  echo "--- $label ---"
  adb shell dumpsys activity activities | grep -F "$PKG/.CaptureActivity" || true
  adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
  adb pull /sdcard/window.xml /tmp/window.xml >/dev/null 2>&1 || true
  if [ -f /tmp/window.xml ]; then
    echo 'visible text:'
    sed 's/></>\n</g' /tmp/window.xml \
      | sed -n 's/.* text="\([^"]*\)".*/\1/p' \
      | grep -v '^$' \
      | head -80 || true
  fi
  adb shell dumpsys notification --noredact > /tmp/notifications.txt
  echo 'app notifications:'
  grep -E "$PKG|video_downloads|영상 저장 도구|영상 저장 실패|직접 다운로드" /tmp/notifications.txt || true
}

snapshot 'after initial page load'

# Exercise the actual web page area, not only our helper button. The WebView begins below y~260.
echo '--- tap probable player areas ---'
adb shell input tap 540 760
sleep 8
snapshot 'after first page tap'
adb shell input tap 540 1180
sleep 8
snapshot 'after second page tap'

# Also invoke the app's explicit helper button if it is still visible.
adb shell input tap 270 198
sleep 8
snapshot 'after helper play button'

if adb logcat -d -b crash | grep -F "$PKG"; then
  echo 'App crashed while handling the reported URL'
  exit 1
fi

echo '--- relevant WebView/runtime errors ---'
adb logcat -d \
  | grep -Ei 'chromium|AwContents|net::ERR|SSL|Cleartext|ForegroundService|SecurityException|AndroidRuntime' \
  | tail -160 || true

# This is an observation test. It fails only for app/runtime crashes or Android execution violations.
LOG=$(adb logcat -d)
if echo "$LOG" | grep -E 'ForegroundServiceStartNotAllowedException|MissingForegroundServiceTypeException|SecurityException.*foreground' | grep -F "$PKG"; then
  echo 'Foreground service violated Android runtime rules'
  exit 1
fi
