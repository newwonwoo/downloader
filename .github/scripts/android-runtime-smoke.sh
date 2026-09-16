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
sleep 20
adb shell dumpsys activity activities | grep -F "$PKG/.CaptureActivity" || true
adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
adb pull /sdcard/window.xml /tmp/window.xml >/dev/null 2>&1 || true
if [ -f /tmp/window.xml ]; then
  echo '--- visible app status ---'
  sed 's/></>\n</g' /tmp/window.xml | grep -E '공유된 영상을|영상 주소를|보안 확인|영상 플레이어|직접 다운로드|영상 재생|다시 시도' || true
fi
if adb logcat -d -b crash | grep -F "$PKG"; then
  echo 'App crashed while handling the reported URL'
  exit 1
fi

echo '--- foreground service notification smoke ---'
adb shell am start-foreground-service \
  -n "$PKG/.HlsDownloadService" \
  --es stream 'https://surrit.com/__runtime_smoke__/master.m3u8' \
  --es page 'https://njavtv.com/ko/dvaj-041-uncensored-leak' \
  --es title 'runtime-smoke'
sleep 1
adb shell dumpsys notification --noredact > /tmp/notifications.txt
grep -F "$PKG" /tmp/notifications.txt
grep -E 'video_downloads|영상 저장 도구|영상 저장 실패|직접 다운로드' /tmp/notifications.txt || true

LOG=$(adb logcat -d)
if echo "$LOG" | grep -E 'ForegroundServiceStartNotAllowedException|MissingForegroundServiceTypeException|SecurityException.*foreground' | grep -F "$PKG"; then
  echo 'Foreground service violated Android runtime rules'
  exit 1
fi
