#!/usr/bin/env bash
set -euo pipefail

PKG=com.newwonwoo.downloader.capture
APK=$(find /tmp/apk -name '*.apk' -print -quit)
test -n "$APK"

adb install -r "$APK"
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS
adb logcat -c

echo '--- exact reported URL share-intent smoke ---'
adb shell am force-stop "$PKG"
adb shell am start -W \
  -a android.intent.action.SEND \
  -t text/plain \
  --es android.intent.extra.TEXT 'https://njavtv.com/ko/dvaj-041-uncensored-leak' \
  -n "$PKG/.CaptureActivity"
sleep 20

echo '--- verify app stayed alive and exposed status ---'
adb shell pidof "$PKG" >/dev/null
adb shell dumpsys notification --noredact > /tmp/notifications.txt
if ! grep -F "$PKG" /tmp/notifications.txt >/dev/null; then
  echo 'Expected analysis/download notification was not posted'
  cat /tmp/notifications.txt | tail -200
  exit 1
fi

echo '--- visible app text ---'
adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
adb pull /sdcard/window.xml /tmp/window.xml >/dev/null 2>&1 || true
if [ -f /tmp/window.xml ]; then
  sed 's/></>\n</g' /tmp/window.xml \
    | sed -n 's/.* text="\([^"]*\)".*/\1/p' \
    | grep -v '^$' \
    | head -100 || true
fi

if adb logcat -d -b crash | grep -F "$PKG"; then
  echo 'Application crashed while handling the reported URL'
  exit 1
fi

echo '--- background survival smoke ---'
adb shell input keyevent KEYCODE_HOME
sleep 5
adb shell pidof "$PKG" >/dev/null
adb shell dumpsys notification --noredact > /tmp/notifications-background.txt
grep -F "$PKG" /tmp/notifications-background.txt >/dev/null

echo '--- capture/download diagnostic log ---'
adb logcat -d | grep -E 'VideoSaveCapture|VideoSaveDownload' || true

LOG=$(adb logcat -d)
if echo "$LOG" | grep -E 'ForegroundServiceStartNotAllowedException|MissingForegroundServiceTypeException|SecurityException.*foreground' | grep -F "$PKG"; then
  echo 'Foreground service violated Android runtime rules'
  exit 1
fi
