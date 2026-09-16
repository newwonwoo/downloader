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
  tail -200 /tmp/notifications.txt
  exit 1
fi

dump_ui() {
  adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
  adb pull /sdcard/window.xml /tmp/window.xml >/dev/null 2>&1 || true
}

tap_text() {
  local wanted="$1"
  dump_ui
  python3 - "$wanted" <<'PY'
import re, subprocess, sys, xml.etree.ElementTree as ET
wanted=sys.argv[1]
root=ET.parse('/tmp/window.xml').getroot()
for node in root.iter('node'):
    if node.attrib.get('text') != wanted:
        continue
    m=re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.attrib.get('bounds',''))
    if not m:
        continue
    x1,y1,x2,y2=map(int,m.groups())
    x=(x1+x2)//2; y=(y1+y2)//2
    print(f'tapping {wanted} at {x},{y}')
    subprocess.check_call(['adb','shell','input','tap',str(x),str(y)])
    sys.exit(0)
print(f'{wanted} button not found')
sys.exit(2)
PY
}

echo '--- visible app text before playback ---'
dump_ui
if [ -f /tmp/window.xml ]; then
  sed 's/></>\n</g' /tmp/window.xml \
    | sed -n 's/.* text="\([^"]*\)".*/\1/p' \
    | grep -v '^$' \
    | head -100 || true
fi

echo '--- explicit playback attempt ---'
tap_text '영상 재생'
sleep 15

adb shell dumpsys notification --noredact > /tmp/notifications-after-play.txt
grep -F "$PKG" /tmp/notifications-after-play.txt >/dev/null

echo '--- capture result after playback ---'
adb logcat -d | grep -E 'VideoSaveCapture|VideoSaveDownload' || true

if adb logcat -d -b crash | grep -F "$PKG"; then
  echo 'Application crashed while handling the reported URL'
  exit 1
fi

echo '--- background survival smoke ---'
adb shell input keyevent KEYCODE_HOME
sleep 5
adb shell pidof "$PKG" >/dev/null || {
  echo 'App process did not survive background transition'
  exit 1
}
adb shell dumpsys notification --noredact > /tmp/notifications-background.txt
grep -F "$PKG" /tmp/notifications-background.txt >/dev/null

LOG=$(adb logcat -d)
if echo "$LOG" | grep -E 'ForegroundServiceStartNotAllowedException|MissingForegroundServiceTypeException|SecurityException.*foreground' | grep -F "$PKG"; then
  echo 'Foreground service violated Android runtime rules'
  exit 1
fi
