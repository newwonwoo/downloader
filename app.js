const FRONTEND_VERSION = 'single-path-v2-browser-handoff';
const $ = (id) => document.getElementById(id);
const state = { result: null };
const HLS_IMPORT_HOSTS = ['surrit.com', 'nineyu.com'];

function setAnalyzing(active) {
  $('analyzeButton').disabled = active;
  $('analyzeButton').textContent = active ? '분석 중…' : '영상 찾기';
  $('status').classList.toggle('show', active);
  if (active) {
    $('statusTitle').textContent = '페이지를 분석하고 있습니다';
    $('statusText').textContent = '다운로드 서버와 재생 주소를 확인합니다.';
    $('error').classList.remove('show');
    $('result').classList.remove('show');
  }
}

function showError(message) {
  $('error').textContent = message;
  $('error').classList.add('show');
  $('status').classList.remove('show');
}

function updateProgress(percent, title, message) {
  $('download').classList.add('show');
  const progress = $('progressBar').parentElement;
  progress.hidden = false;
  const numeric = Number(percent);
  $('progressBar').style.width = Number.isFinite(numeric)
    ? `${Math.max(0, Math.min(100, numeric))}%`
    : '0%';
  $('downloadPercent').textContent = typeof percent === 'number'
    ? `${Math.round(percent)}%`
    : String(percent || '');
  $('downloadTitle').textContent = title;
  $('downloadMessage').textContent = message;
}

function errorMessage(data, status) {
  if (typeof data?.detail === 'string') return data.detail;
  if (typeof data?.message === 'string') return data.message;
  const code = data?.detail?.code || data?.code;
  const known = {
    SOURCE_BLOCKED: '원본 사이트의 보안 확인 때문에 서버 분석이 막혔습니다. 아래 NJAVTV 추출 도우미를 이용해 주세요.',
    STREAM_NOT_FOUND: '영상 재생 주소를 찾지 못했습니다.',
    STREAM_UNAVAILABLE: '현재 재생 가능한 화질을 찾지 못했습니다.',
    MASTER_UNAVAILABLE: '영상 화질 목록을 불러오지 못했습니다.',
  };
  return known[code] || `영상 분석에 실패했습니다. (${status || 'network'})`;
}

function isNjavUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'njavtv.com' || host === 'www.njavtv.com');
  } catch {
    return false;
  }
}

function allowedImportedHls(value) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !/\.m3u8$/i.test(url.pathname)) return null;
    if (!HLS_IMPORT_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return null;
    return url.href;
  } catch {
    return null;
  }
}

function importedQuality(value) {
  const match = String(value).match(/\/(1920x1080|1280x720|842x480|640x360|1080p|720p|480p|360p)\//i);
  return match ? match[1] : '자동';
}

function importedHeight(quality) {
  const values = {
    '1920x1080': 1080,
    '1080p': 1080,
    '1280x720': 720,
    '720p': 720,
    '842x480': 480,
    '480p': 480,
    '640x360': 360,
    '360p': 360,
  };
  return values[quality] || 0;
}

function importedVideoId(value) {
  return String(value).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] || null;
}

function showHelper() {
  $('helperPanel')?.removeAttribute('hidden');
}

function hideHelper() {
  $('helperPanel')?.setAttribute('hidden', '');
}

function browserHandoffCode() {
  const target = JSON.stringify(`${window.location.origin}${window.location.pathname}`);
  return `javascript:(()=>{let n=0;const abs=u=>{try{return new URL(u,location.href).href}catch{return''}};const find=()=>{let u=(window.hls&&window.hls.url)||'';if(!u){for(const v of document.querySelectorAll('video')){u=(v._hls&&v._hls.url)||((/\\.m3u8(?:\\?|$)/i.test(v.currentSrc||''))?v.currentSrc:'')||((/\\.m3u8(?:\\?|$)/i.test(v.src||''))?v.src:'');if(u)break}}if(!u){const a=performance.getEntriesByType('resource').map(e=>e.name).filter(x=>/\\.m3u8(?:\\?|$)/i.test(x));u=a[a.length-1]||''}u=abs(u);if(u){const p=new URLSearchParams({hls:u,title:document.title||'NJAVTV video',source:location.origin+location.pathname});location.href=${target}+'#'+p.toString();return}if(++n<12){setTimeout(find,1000);return}alert('영상 재생 버튼을 한 번 누른 뒤 추출 북마크를 다시 실행하세요.');};find()})()`;
}

function importBrowserHandoff() {
  if (!window.location.hash || window.location.hash.length < 2) return false;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const hls = allowedImportedHls(params.get('hls'));
  if (!hls) return false;

  const source = String(params.get('source') || '').trim();
  const title = String(params.get('title') || 'NJAVTV 영상').trim().slice(0, 180) || 'NJAVTV 영상';
  const quality = importedQuality(hls);
  if (isNjavUrl(source)) $('pageUrl').value = source;

  const result = {
    ok: true,
    resolver: 'browser-handoff-v2',
    title,
    videoId: importedVideoId(hls),
    pageUrl: isNjavUrl(source) ? source : '',
    streams: [{
      quality,
      height: importedHeight(quality),
      url: hls,
      available: true,
      manifestType: 'hls',
    }],
  };

  state.result = result;
  if (typeof window.renderResult !== 'function') {
    throw new Error('저장 화면을 준비하지 못했습니다. 페이지를 새로고침해 주세요.');
  }
  window.renderResult(result);
  hideHelper();
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

async function analyze(event) {
  event.preventDefault();
  const url = $('pageUrl').value.trim();
  const njav = isNjavUrl(url);
  if (njav) showHelper();
  else hideHelper();

  setAnalyzing(true);
  void window.warmDownloaderWorker?.().catch(() => {});

  try {
    const response = await fetch('/api/video-resolve', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({url}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(errorMessage(data, response.status));
    state.result = data;
    if (typeof window.renderResult !== 'function') throw new Error('저장 화면을 준비하지 못했습니다.');
    window.renderResult(data);
    hideHelper();
  } catch (error) {
    showError(error?.message || '영상 분석에 실패했습니다.');
    if (njav) showHelper();
  } finally {
    setAnalyzing(false);
  }
}

$('analyzeForm').addEventListener('submit', analyze);
$('copyHelper')?.addEventListener('click', async () => {
  const button = $('copyHelper');
  try {
    await navigator.clipboard.writeText(browserHandoffCode());
    const previous = button.textContent;
    button.textContent = '복사됨';
    setTimeout(() => { button.textContent = previous; }, 1400);
  } catch {
    showError('추출 도우미 코드를 복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해 주세요.');
  }
});

window.addEventListener('DOMContentLoaded', () => {
  try {
    importBrowserHandoff();
  } catch (error) {
    showError(error?.message || '가져온 영상 주소를 처리하지 못했습니다.');
  }
});
window.addEventListener('pageshow', () => void window.warmDownloaderWorker?.().catch(() => {}));
