// Prepare a complete file, then let the native manager GET a sized attachment.
(() => {
  const BASE = 'https://unisquads-downloader-worker.onrender.com';
  const KEY = 'downloader-complete-file-v1';
  let active = null;
  let polling = false;
  let timer;
  let failures = 0;
  let generation = 0;
  let controller;
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const persist = value => { active = value; try { if (value) localStorage.setItem(KEY, JSON.stringify(value)); else localStorage.removeItem(KEY); } catch {} };
  const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  function saveLink() {
    let link = document.getElementById('fileSaveButton');
    if (!link) {
      link = document.createElement('a');
      link.id = 'fileSaveButton';
      link.className = 'save native-link';
      link.target = '_self';
      link.textContent = '휴대폰에 저장';
      document.getElementById('download').append(link);
    }
    return link;
  }
  async function request(path, options = {}) {
    const response = await fetch(BASE + path, {...options, cache: 'no-store', credentials: 'omit', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof data.detail === 'string' ? data.detail : `서버 응답 오류 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function show(job) {
    const ready = job.status === 'ready';
    const failed = job.status === 'failed';
    const fraction = job.totalSegments ? job.completedSegments / job.totalSegments : 0;
    updateProgress(ready ? 100 : Math.min(99, fraction * 100),
      ready ? 'MP4 준비 완료' : failed ? '파일 준비 실패' : '서버에서 MP4 준비 중',
      `${job.title} · ${job.quality} · ${mb(job.bytes || 0)}${job.totalSegments ? ` · ${job.completedSegments}/${job.totalSegments} 조각` : ''}`);
    document.querySelector('.progress').hidden = ready || failed;
    document.getElementById('downloadPercent').textContent = ready ? '준비 완료' : failed ? '실패' : `${Math.floor(fraction * 100)}%`;
    const link = saveLink();
    link.hidden = !ready;
    link.removeAttribute('href');
    if (ready) {
      if (!/^\/files\/[A-Za-z0-9_-]+\.mp4$/.test(job.file_url || '')) throw new Error('저장 주소가 올바르지 않습니다.');
      link.href = BASE + job.file_url;
      document.getElementById('downloadMessage').textContent += ' · 아래 저장 버튼을 누르세요. 임시 파일은 마지막 사용 후 1시간 보관되며 서버 재시작 시 없어질 수 있습니다.';
    } else if (failed) showError(job.message || '파일 준비에 실패했습니다.');
    document.querySelectorAll('.prepare-file').forEach(button => { button.disabled = !ready && !failed; });
  }
  async function poll() {
    if (!active || polling || document.hidden) return;
    const current = ++generation;
    controller = new AbortController();
    polling = true;
    clearTimeout(timer);
    try {
      const job = active.id ? await request(`/jobs/${active.id}`) : await request('/jobs', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(active.request)
      });
      if (current !== generation) return;
      if (!job.id || !['preparing', 'ready', 'failed'].includes(job.status)) throw new Error('서버가 아직 작업 상태를 보내지 않았습니다.');
      persist({...active, id: job.id, status: job.status, snapshot: job});
      failures = 0;
      document.getElementById('retryFileJob')?.remove();
      document.getElementById('result').classList.add('show');
      document.getElementById('error').classList.remove('show');
      show(job);
      if (job.status === 'preparing') timer = setTimeout(poll, 2500);
    } catch (error) {
      if (current !== generation) return;
      document.getElementById('result').classList.add('show');
      if ([400, 404, 409, 410, 422, 507].includes(error.status)) {
        persist(null);
        saveLink().hidden = true;
        showError(error.message);
        updateProgress(0, '파일을 다시 준비하세요', error.message);
        document.querySelectorAll('.prepare-file').forEach(button => { button.disabled = false; });
      } else {
        failures += 1;
        document.getElementById('downloadTitle').textContent = '진행 상태 다시 연결 중';
        document.getElementById('downloadMessage').textContent = '마지막 확인 상태입니다. 서버 작업을 다시 조회합니다. ' + (error.message || '');
        if (failures < 3) timer = setTimeout(poll, 5000);
        else {
          showError('서버 상태를 확인하지 못했습니다. 아래 작업 다시 확인 버튼을 눌러주세요.');
          if (!document.getElementById('retryFileJob')) {
            const retry = document.createElement('button');
            retry.id = 'retryFileJob'; retry.textContent = '작업 다시 확인';
            retry.addEventListener('click', () => { failures = 0; void poll(); });
            document.getElementById('download').append(retry);
          }
        }
      }
    } finally { if (current === generation) polling = false; }
  }
  async function start(stream) {
    if (active && !['ready', 'failed'].includes(active.status)) { await poll(); return; }
    saveLink().hidden = true;
    document.getElementById('error').classList.remove('show');
    persist({status: 'preparing', result: state.result, request: {stream_url: stream.url,
      title: state.result?.title || 'video', quality: stream.quality || 'video', request_key: crypto.randomUUID()}});
    document.querySelectorAll('.prepare-file').forEach(button => { button.disabled = true; });
    updateProgress(0, '파일 준비 요청 중', '완성된 파일을 준비한 뒤 휴대폰에 저장합니다.');
    await poll();
  }
  window.renderResult = (data, restoring = false) => {
    document.getElementById('videoTitle').textContent = data.title || '영상';
    document.getElementById('videoCode').textContent = data.videoId?.slice(0, 8) || 'HLS';
    const rows = document.getElementById('streams');
    rows.replaceChildren();
    for (const stream of [...data.streams].sort((a,b) => (b.height || 0) - (a.height || 0))) {
      const row = document.createElement('div'); row.className = 'stream';
      row.innerHTML = '<div><div class="quality"></div><div class="streammeta">완성된 MP4 파일로 저장</div></div><div class="actions"><button class="save prepare-file" type="button">MP4 준비</button><button class="copy" type="button">주소 복사</button></div>';
      row.querySelector('.quality').textContent = stream.quality;
      row.querySelector('.save').addEventListener('click', () => start(stream));
      row.querySelector('.copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(stream.url); } catch { showError('주소를 복사하지 못했습니다.'); }
      });
      rows.append(row);
    }
    document.getElementById('result').classList.add('show');
    document.getElementById('error').classList.remove('show');
    if (active && !restoring) void poll();
  };
  function suspend() {
    clearTimeout(timer);
    generation += 1;
    controller?.abort();
    polling = false;
  }
  function resume() {
    if (document.hidden) return;
    suspend();
    active = active || read();
    if (!active) return;
    failures = 0;
    if (active.result) {
      state.result = active.result;
      window.renderResult(active.result, true);
    }
    document.getElementById('result').classList.add('show');
    document.getElementById('videoTitle').textContent = active.snapshot?.title || active.request?.title || '진행 중인 영상';
    if (active.snapshot) show(active.snapshot);
    else updateProgress(0, '기존 작업 확인 중', '저장된 작업을 다시 연결합니다. 영상을 다시 찾을 필요가 없습니다.');
    document.getElementById('downloadMessage').textContent += ' · 최신 상태 확인 중';
    document.querySelectorAll('.prepare-file').forEach(button => { button.disabled = active.status === 'preparing'; });
    void poll();
  }
  document.addEventListener('visibilitychange', () => document.hidden ? suspend() : resume());
  window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', resume);
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
  persist(read());
  resume();
})();
