const FRONTEND_VERSION = 'single-path-v1';
const $ = (id) => document.getElementById(id);
const state = { result: null };

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
    SOURCE_BLOCKED: '원본 사이트의 보안 확인 때문에 영상을 분석하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
    STREAM_NOT_FOUND: '영상 재생 주소를 찾지 못했습니다.',
    STREAM_UNAVAILABLE: '현재 재생 가능한 화질을 찾지 못했습니다.',
    MASTER_UNAVAILABLE: '영상 화질 목록을 불러오지 못했습니다.',
  };
  return known[code] || `영상 분석에 실패했습니다. (${status || 'network'})`;
}

async function analyze(event) {
  event.preventDefault();
  const url = $('pageUrl').value.trim();
  setAnalyzing(true);
  void window.warmDownloaderWorker?.().catch(() => {});

  try {
    const response = await fetch('/api/video-resolve', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({url}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(errorMessage(data, response.status));
    state.result = data;
    if (typeof window.renderResult !== 'function') throw new Error('저장 화면을 준비하지 못했습니다.');
    window.renderResult(data);
  } catch (error) {
    showError(error?.message || '영상 분석에 실패했습니다.');
  } finally {
    setAnalyzing(false);
  }
}

$('analyzeForm').addEventListener('submit', analyze);
window.addEventListener('pageshow', () => void window.warmDownloaderWorker?.().catch(() => {}));
