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

adb shell pidof "$PKG" >/dev/null
adb shell dumpsys notification --noredact > /tmp/notifications.txt
grep -F "$PKG" /tmp/notifications.txt >/dev/null

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
    if not m: continue
    x1,y1,x2,y2=map(int,m.groups())
    subprocess.check_call(['adb','shell','input','tap',str((x1+x2)//2),str((y1+y2)//2)])
    print(f'tapped text={wanted}')
    sys.exit(0)
print(f'{wanted} not found')
sys.exit(2)
PY
}

tap_webview_fraction() {
  local fy="$1"
  dump_ui
  python3 - "$fy" <<'PY'
import re, subprocess, sys, xml.etree.ElementTree as ET
fy=float(sys.argv[1])
root=ET.parse('/tmp/window.xml').getroot()
for node in root.iter('node'):
    if node.attrib.get('class') != 'android.webkit.WebView':
        continue
    m=re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.attrib.get('bounds',''))
    if not m: continue
    x1,y1,x2,y2=map(int,m.groups())
    x=(x1+x2)//2
    y=round(y1+(y2-y1)*fy)
    print(f'tapping WebView at {x},{y} fraction={fy} bounds={x1},{y1},{x2},{y2}')
    subprocess.check_call(['adb','shell','input','tap',str(x),str(y)])
    sys.exit(0)
print('WebView node not found')
sys.exit(2)
PY
}

echo '--- helper playback attempt ---'
tap_text '영상 재생'
sleep 10

if ! adb logcat -d | grep -F 'VideoSaveCapture' | grep -F 'HLS candidate host=' >/dev/null; then
  echo '--- no HLS yet; native taps inside actual WebView ---'
  tap_webview_fraction 0.25
  sleep 8
fi
if ! adb logcat -d | grep -F 'VideoSaveCapture' | grep -F 'HLS candidate host=' >/dev/null; then
  tap_webview_fraction 0.45
  sleep 8
fi
if ! adb logcat -d | grep -F 'VideoSaveCapture' | grep -F 'HLS candidate host=' >/dev/null; then
  tap_webview_fraction 0.65
  sleep 8
fi

echo '--- capture/download diagnostic log ---'
adb logcat -d | grep -E 'VideoSaveCapture|VideoSaveDownload' || true

if ! adb logcat -d | grep -F 'VideoSaveCapture' | grep -F 'HLS candidate host=' >/dev/null; then
  echo 'Reported page did not expose an HLS candidate after helper and native player taps'
  exit 1
fi

if adb logcat -d -b crash | grep -F "$PKG"; then
  echo 'Application crashed while handling the reported URL'
  exit 1
fi

echo '--- background/service survival smoke ---'
adb shell input keyevent KEYCODE_HOME
sleep 5
adb shell dumpsys notification --noredact > /tmp/notifications-background.txt
grep -F "$PKG" /tmp/notifications-background.txt >/dev/null

LOG=$(adb logcat -d)
if echo "$LOG" | grep -E 'ForegroundServiceStartNotAllowedException|MissingForegroundServiceTypeException|SecurityException.*foreground' | grep -F "$PKG"; then
  echo 'Foreground service violated Android runtime rules'
  exit 1
fi
