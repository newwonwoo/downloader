// Native handoff v4: a real user-clicked, top-level link; no hidden frame.
const NATIVE_DOWNLOAD_BASE = 'https://unisquads-downloader-worker.onrender.com';
const NATIVE_READY_TTL = 60_000;
let nativeReadyAt = 0;
let nativeWarmPromise = null;
let nativeRenderVersion = 0;

function nativeStatus(label, title, message) {
  updateProgress('', title, message);
  document.getElementById('downloadPercent').textContent = label;
  const progress = document.getElementById('progressBar');
  progress.style.width = '0%';
  progress.parentElement.hidden = true;
  document.getElementById('download').setAttribute('aria-live', 'polite');
}

function nativeUrl(stream) {
  const media = new URL(stream.url);
  const host = media.hostname.toLowerCase();
  if (media.protocol !== 'https:' || media.username || media.password ||
      (media.port && media.port !== '443') ||
      !['surrit.com', 'nineyu.com'].some(s => host === s || host.endsWith(`.${s}`))) {
    throw new Error('지원하지 않는 영상 주소입니다.');
  }
  const url = new URL('/download', NATIVE_DOWNLOAD_BASE);
  url.searchParams.set('stream_url', media.href);
  url.searchParams.set('title', state.result?.title || 'video');
  url.searchParams.set('quality', stream.quality || 'video');
  return url.href;
}

function isNativeReady() {
  return nativeReadyAt > 0 && Date.now() - nativeReadyAt < NATIVE_READY_TTL;
}

function prewarmNativeDownloadServer() {
  if (isNativeReady()) return Promise.resolve();
  if (nativeWarmPromise) return nativeWarmPromise;
  nativeWarmPromise = (async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(20_000, deadline - Date.now()));
      try {
        const response = await fetch(`${NATIVE_DOWNLOAD_BASE}/health`, {
          method: 'GET', mode: 'cors', cache: 'no-store', credentials: 'omit',
          signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        if (response.ok && data?.ok === true &&
            String(data.mode || '').startsWith('native-mobile-stream-')) {
          nativeReadyAt = Date.now();
          return;
        }
      } catch {
      } finally {
        clearTimeout(timer);
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(2000, remaining)));
    }
    throw new Error('다운로드 서버가 90초 안에 준비되지 않았습니다. 아직 다운로드는 시작되지 않았습니다.');
  })().finally(() => { nativeWarmPromise = null; });
  return nativeWarmPromise;
}

function setNativeLinksReady(ready) {
  document.querySelectorAll('a[data-native-download]').forEach(link => {
    if (ready) link.href = link.dataset.nativeDownload;
    else link.removeAttribute('href');
    link.setAttribute('aria-disabled', String(!ready));
    link.textContent = ready ? 'MP4 저장' : '서버 준비 중…';
  });
}

async function readyNativeLinks() {
  const version = nativeRenderVersion;
  setNativeLinksReady(false);
  nativeStatus('준비 중', '다운로드 서버 확인 중', '서버 응답을 확인하고 있습니다. 준비되면 MP4 저장 버튼이 활성화됩니다.');
  try {
    await prewarmNativeDownloadServer();
    if (version !== nativeRenderVersion) return;
    setNativeLinksReady(true);
    nativeStatus('준비됨', '다운로드 서버 준비됨', '위의 MP4 저장을 누르면 현재 탭에서 실제 파일 주소를 엽니다. 저장 안내 또는 다운로드 알림을 확인하세요.');
    document.getElementById('error').classList.remove('show');
  } catch (error) {
    if (version !== nativeRenderVersion) return;
    setNativeLinksReady(false);
    document.querySelectorAll('a[data-native-download]').forEach(link => {
      link.textContent = '서버 연결 재시도';
    });
    nativeStatus('실패', '다운로드 시작 안 됨', error.message);
    showError(error.message);
  }
}

function onNativeDownloadClick(event) {
  const link = event.currentTarget;
  if (!isNativeReady() || link.getAttribute('aria-disabled') === 'true') {
    event.preventDefault();
    void readyNativeLinks();
    return;
  }
  const url = new URL(link.dataset.nativeDownload);
  url.searchParams.set('request_id', globalThis.crypto?.randomUUID?.() || String(Date.now()));
  link.href = url.href;
  nativeStatus('확인 필요', '파일 다운로드 요청', '브라우저에 파일 주소를 열도록 요청했습니다. 다운로드 목록에 파일이 나타나야 시작된 것입니다. 이 페이지에서는 저장 완료 여부를 확인할 수 없습니다.');
}

window.renderResult = function renderNativeResult(data) {
  nativeRenderVersion += 1;
  document.getElementById('videoTitle').textContent = data.title || '영상';
  document.getElementById('videoCode').textContent = data.videoId ? data.videoId.slice(0, 8) : 'HLS';
  const container = document.getElementById('streams');
  container.replaceChildren();
  const streams = [...(data.streams || [])].sort((a, b) =>
    (b.height || QUALITY_SCORE[b.quality] || 0) - (a.height || QUALITY_SCORE[a.quality] || 0));
  for (const stream of streams) {
    const row = document.createElement('div');
    row.className = 'stream';
    row.innerHTML = '<div><div class="quality"></div><div class="streammeta"></div></div><div class="actions"><a class="save native-link" role="link" tabindex="0">MP4 저장</a><button class="copy" type="button">주소 복사</button></div>';
    row.querySelector('.quality').textContent = stream.quality || '자동 화질';
    row.querySelector('.streammeta').textContent = stream.available === false ? '후보 주소 · 서버에서 저장 가능 여부 확인' : '일반 파일 다운로드';
    row.querySelector('.copy').addEventListener('click', async event => {
      const button = event.currentTarget;
      try { await navigator.clipboard.writeText(stream.url); button.textContent = '복사됨'; }
      catch { showError('주소를 복사하지 못했습니다.'); }
    });
    const link = row.querySelector('.save');
    try { link.dataset.nativeDownload = nativeUrl(stream); }
    catch (error) { link.textContent = '지원하지 않는 주소'; link.setAttribute('aria-disabled', 'true'); container.appendChild(row); continue; }
    link.target = '_self';
    link.rel = 'noreferrer';
    link.addEventListener('click', onNativeDownloadClick);
    link.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !link.hasAttribute('href')) {
        event.preventDefault();
        void readyNativeLinks();
      }
    });
    container.appendChild(row);
  }
  document.getElementById('result').classList.add('show');
  document.getElementById('error').classList.remove('show');
  void readyNativeLinks();
};

window.restoreBackgroundJob = async () => {};
window.ensureBackgroundRegistration = async () => null;
async function clearLegacyBackgroundDownloads() {
  try {
    const keys = ['downloader-render-job-v1', BG_JOB_KEY];
    const saved = keys.map(key => localStorage.getItem(key));
    let savedId;
    try { savedId = JSON.parse(saved[1] || 'null')?.id; } catch {}
    const scope = new URL('./', location.href).href;
    const registration = await navigator.serviceWorker?.getRegistration?.(scope);
    if (registration && registration.scope !== scope) return;
    const manager = registration?.backgroundFetch;
    const ids = await manager?.getIds?.() || [];
    for (const id of ids) {
      if (id !== savedId && !id.startsWith('video-')) continue;
      const job = await manager.get(id);
      if (job && !job.result) {
        const aborted = await job.abort();
        if (aborted === false && !job.result) throw new Error('legacy abort incomplete');
      }
    }
    keys.forEach((key, index) => {
      if (localStorage.getItem(key) === saved[index]) localStorage.removeItem(key);
    });
  } catch {
    console.warn('Legacy download cleanup incomplete; saved IDs retained for retry.');
  }
}
void clearLegacyBackgroundDownloads();
state.backgroundJobId = null;
state.abortController = null;
document.getElementById('cancelButton').hidden = true;
document.querySelectorAll('iframe[name="native-download-frame"]').forEach(frame => frame.remove());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !isNativeReady() && document.querySelector('a[data-native-download]')) {
    void readyNativeLinks();
  }
});
void prewarmNativeDownloadServer().catch(() => {});
