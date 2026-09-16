#!/usr/bin/env bash
set -euo pipefail

PKG=com.newwonwoo.downloader.capture
APK=$(find /tmp/apk -name '*.apk' -print -quit)
SHORT_SHA="${GITHUB_SHA:0:8}"
test -n "$APK"

save_diagnostics() {
  adb exec-out screencap -p > runtime-after.png 2>/dev/null || true
  adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
  adb pull /sdcard/window.xml runtime-window.xml >/dev/null 2>&1 || true
  adb logcat -d > runtime-logcat.txt 2>/dev/null || true
}
trap save_diagnostics EXIT

dump_ui() {
  adb shell uiautomator dump /sdcard/window.xml >/dev/null 2>&1 || true
  adb pull /sdcard/window.xml /tmp/window.xml >/dev/null 2>&1 || true
  test -s /tmp/window.xml
  cp /tmp/window.xml runtime-window.xml
}

assert_no_app_crash() {
  if adb logcat -d -b crash | grep -F "$PKG"; then
    echo 'Application process crashed while handling the reported URL'
    exit 1
  fi
}

has_hls_candidate() {
  adb logcat -d | grep -F 'VideoSaveCapture' | grep -F 'HLS candidate host=' >/dev/null
}

stream_validated() {
  adb logcat -d | grep -F 'VideoSaveDownload' | grep -F 'stream validated segments=' >/dev/null
}

target_external_blocked() {
  if dump_ui; then
    if grep -Eiq 'ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_TIMED_OUT|Webpage not available|Just a moment|Verify you are human|Cloudflare' /tmp/window.xml; then
      return 0
    fi
  fi
  adb logcat -d | grep -F 'VideoSaveCapture' | grep -F 'main frame load failed' >/dev/null
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

adb install -r "$APK"
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS
adb logcat -c

echo '--- build identity smoke ---'
adb shell am force-stop "$PKG"
adb shell am start -W -n "$PKG/.CaptureActivity"
sleep 3
dump_ui
grep -F 'v2.0 (4)' /tmp/window.xml >/dev/null
grep -F "$SHORT_SHA" /tmp/window.xml >/dev/null
grep -F 'dev' /tmp/window.xml >/dev/null
assert_no_app_crash

echo '--- exact reported URL share-intent smoke ---'
adb shell am force-stop "$PKG"
adb logcat -c
adb shell am start -W \
  -a android.intent.action.SEND \
  -t text/plain \
  --es android.intent.extra.TEXT 'https://njavtv.com/ko/dvaj-041-uncensored-leak' \
  -n "$PKG/.CaptureActivity"
sleep 20

adb exec-out screencap -p > runtime-before.png
adb shell pidof "$PKG" >/dev/null
adb shell dumpsys notification --noredact > /tmp/notifications.txt
grep -F "$PKG" /tmp/notifications.txt >/dev/null
assert_no_app_crash

if ! stream_validated && ! has_hls_candidate && ! target_external_blocked; then
  echo '--- helper playback attempt ---'
  if tap_text '영상 재생'; then
    sleep 10
  else
    echo '영상 재생 helper button unavailable; continuing with WebView probe'
  fi
fi

if ! stream_validated && ! has_hls_candidate && ! target_external_blocked; then
  echo '--- no HLS yet; native taps inside actual WebView ---'
  for fraction in 0.20 0.35 0.50 0.70; do
    if tap_webview_fraction "$fraction"; then
      sleep 6
    fi
    if stream_validated || has_hls_candidate || target_external_blocked; then
      break
    fi
  done
fi

echo '--- WebView/download diagnostics ---'
adb logcat -d | grep -Ei 'VideoSaveCapture|VideoSaveDownload|chromium|AwContents|net::ERR|SSL' | tail -300 || true

if stream_validated; then
  echo 'TARGET_CAPTURE=stream_validated'
elif has_hls_candidate; then
  echo 'TARGET_CAPTURE=candidate_observed'
elif target_external_blocked; then
  echo 'TARGET_CAPTURE=external_blocked'
  echo 'The reported external page is unavailable/challenged in the CI emulator; app runtime smoke remains valid.'
else
  echo 'TARGET_CAPTURE=no_candidate'
  echo 'Reported page loaded, but no HLS candidate was observed after helper/native playback probes.'
  exit 1
fi

if adb logcat -d | grep -F 'VideoSaveDownload' | grep -F 'direct HLS failed' >/dev/null; then
  echo 'Direct HLS service failed during the smoke observation window'
  exit 1
fi

assert_no_app_crash
adb shell input keyevent KEYCODE_HOME
sleep 5
adb shell dumpsys notification --noredact > /tmp/notifications-background.txt
grep -F "$PKG" /tmp/notifications-background.txt >/dev/null
