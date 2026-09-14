const $ = (id) => document.getElementById(id);
const state = { result: null, abortController: null, backgroundJobId: null, finalizing: false };
const QUALITY_SCORE = {'1920x1080':1080,'1080p':1080,'1280x720':720,'1280p':720,'720p':720,'842x480':480,'480p':480,'360p':360,'자동':0};
const SEGMENT_PREFETCH = 8;
const PROXY_MEDIA_HOSTS = ['surrit.com','nineyu.com'];
const BG_JOB_KEY = 'downloader-bg-active-v1';
const BG_STORAGE_DIR = 'downloader-bg';

function setAnalyzing(active) {
  $('analyzeButton').disabled = active;
  $('analyzeButton').textContent = active ? '분석 중…' : '영상 찾기';
  $('status').classList.toggle('show', active);
  if (active) { $('error').classList.remove('show'); $('result').classList.remove('show'); }
}

function showError(message) {
  $('error').textContent = message;
  $('error').classList.add('show');
  $('status').classList.remove('show');
}

function sanitizeFileName(value) {
  return (value || 'video').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video';
}

function safeJobId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
}

function saveJob(job) {
  localStorage.setItem(BG_JOB_KEY, JSON.stringify(job));
  state.backgroundJobId = job.id;
}

function loadJob() {
  try { return JSON.parse(localStorage.getItem(BG_JOB_KEY) || 'null'); }
  catch { return null; }
}

function clearJob() {
  localStorage.removeItem(BG_JOB_KEY);
  state.backgroundJobId = null;
}

async function ensureBackgroundRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
    const registration = await navigator.serviceWorker.ready;
    if (!registration.backgroundFetch) return null;
    return registration;
  } catch {
    return null;
  }
}

async function readBackgroundMeta(jobId) {
  try {
    const root = await navigator.storage.getDirectory();
    const jobs = await root.getDirectoryHandle(BG_STORAGE_DIR);
    const dir = await jobs.getDirectoryHandle(safeJobId(jobId));
    const handle = await dir.getFileHandle('meta.json');
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

async function getBackgroundRawFile(jobId) {
  const root = await navigator.storage.getDirectory();
  const jobs = await root.getDirectoryHandle(BG_STORAGE_DIR);
  const dir = await jobs.getDirectoryHandle(safeJobId(jobId));
  const handle = await dir.getFileHandle('raw.bin');
  return handle.getFile();
}

async function cleanupBackgroundJob(jobId) {
  try {
    const root = await navigator.storage.getDirectory();
    const jobs = await root.getDirectoryHandle(BG_STORAGE_DIR);
    await jobs.removeEntry(safeJobId(jobId), { recursive: true });
  } catch {}
}

async function analyze(event) {
  event.preventDefault();
  const url = $('pageUrl').value.trim();
  setAnalyzing(true);
  try {
    const response = await fetch('/api/video-resolve', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({url})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.message || '영상 분석에 실패했습니다.');
    state.result = data;
    renderResult(data);
  } catch (error) {
    showError(error.message || '영상 분석에 실패했습니다.');
  } finally {
    setAnalyzing(false);
  }
}

function renderResult(data) {
  $('videoTitle').textContent = data.title || '영상';
  $('videoCode').textContent = data.videoId ? data.videoId.slice(0, 8) : 'HLS';
  const container = $('streams');
  container.innerHTML = '';
  [...data.streams].sort((a,b)=>(QUALITY_SCORE[b.quality]||0)-(QUALITY_SCORE[a.quality]||0)).forEach((stream) => {
    const row = document.createElement('div');
    row.className = 'stream';
    row.innerHTML = `<div><div class="quality"></div><div class="streammeta"></div></div><div class="actions"><button class="save" type="button">MP4 저장</button><button class="copy" type="button">주소 복사</button></div>`;
    row.querySelector('.quality').textContent = stream.quality || '자동 화질';
    row.querySelector('.streammeta').textContent = stream.available === false ? '후보 스트림 · 저장 시 재확인' : '백그라운드 저장 지원';
    row.querySelector('.save').addEventListener('click', () => downloadStream(stream));
    row.querySelector('.copy').addEventListener('click', async (event) => {
      await navigator.clipboard.writeText(stream.url);
      const button = event.currentTarget;
      const original = button.textContent;
      button.textContent = '복사됨';
      setTimeout(() => button.textContent = original, 1200);
    });
    container.appendChild(row);
  });
  $('result').classList.add('show');
  $('error').classList.remove('show');
}

function mustProxy(url) {
  try {
    const host = new URL(url, location.href).hostname.toLowerCase();
    return PROXY_MEDIA_HOSTS.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch { return false; }
}

async function fetchMedia(url, options = {}) {
  if (!mustProxy(url)) {
    try {
      const direct = await fetch(url, {...options, mode:'cors'});
      if (direct.ok) return direct;
    } catch {}
  }
  const proxyUrl = `/api/video-fetch?url=${encodeURIComponent(url)}`;
  const proxied = await fetch(proxyUrl, options);
  if (!proxied.ok) throw new Error(`미디어 요청 실패 (${proxied.status})`);
  return proxied;
}

function absoluteUrl(uri, base) { return new URL(uri.trim(), base).toString(); }

function parseAttributes(line) {
  const attrs = {};
  const text = line.slice(line.indexOf(':') + 1);
  const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match;
  while ((match = regex.exec(text))) attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  return attrs;
}

function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  const variants = [];
  for (let i=0;i<lines.length;i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = parseAttributes(lines[i]);
    const uri = lines.slice(i+1).find(line => !line.startsWith('#'));
    if (!uri) continue;
    const height = Number((attrs.RESOLUTION || '').split('x')[1] || 0);
    variants.push({url:absoluteUrl(uri,baseUrl),height,bandwidth:Number(attrs.BANDWIDTH||0)});
  }
  return variants.sort((a,b)=>(b.height-a.height)||(b.bandwidth-a.bandwidth));
}

function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(v => v.trim());
  let mediaSequence = 0;
  let key = null;
  let mapUrl = null;
  let byteRange = null;
  const segments = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = Number(line.split(':')[1] || 0);
    else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line);
      key = attrs.METHOD === 'NONE' ? null : {method:attrs.METHOD,uri:attrs.URI ? absoluteUrl(attrs.URI,baseUrl) : null,iv:attrs.IV || null};
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line); mapUrl = attrs.URI ? absoluteUrl(attrs.URI,baseUrl) : null;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const raw = line.split(':')[1]; const [length,offset] = raw.split('@').map(Number); byteRange = {length,offset:Number.isFinite(offset)?offset:null};
    } else if (!line.startsWith('#')) {
      segments.push({url:absoluteUrl(line,baseUrl),sequence:mediaSequence+segments.length,key:key?{...key}:null,byteRange}); byteRange=null;
    }
  }
  return {segments,mapUrl,isFmp4:Boolean(mapUrl)};
}

function sequenceIv(sequence) {
  const iv = new Uint8Array(16); let value = BigInt(sequence);
  for (let i=15;i>=0;i--) { iv[i]=Number(value & 255n); value >>= 8n; }
  return iv;
}

function hexIv(raw, sequence) {
  if (!raw) return sequenceIv(sequence);
  const hex = raw.replace(/^0x/i,'').padStart(32,'0').slice(-32);
  return new Uint8Array(hex.match(/.{2}/g).map(v=>parseInt(v,16)));
}

async function decryptAes128(bytes, keyInfo, keyCache, signal) {
  if (!keyInfo) return bytes;
  if (keyInfo.method !== 'AES-128' || !keyInfo.uri) throw new Error('DRM 또는 지원하지 않는 암호화 방식입니다.');
  let keyBytes = keyCache.get(keyInfo.uri);
  if (!keyBytes) {
    const response = await fetchMedia(keyInfo.uri,{signal});
    keyBytes = new Uint8Array(await response.arrayBuffer());
    keyCache.set(keyInfo.uri,keyBytes);
  }
  const cryptoKey = await crypto.subtle.importKey('raw',keyBytes,{name:'AES-CBC'},false,['decrypt']);
  const decrypted = await crypto.subtle.decrypt({name:'AES-CBC',iv:hexIv(keyInfo.iv,keyInfo.sequence)},cryptoKey,bytes);
  return new Uint8Array(decrypted);
}

async function createWriter(fileName) {
  if (navigator.storage?.getDirectory) {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(`tmp-${Date.now()}-${fileName}`,{create:true});
    const writable = await handle.createWritable();
    return {
      async write(chunk){await writable.write(chunk)},
      async finish(){await writable.close();const file=await handle.getFile();return {file,cleanup:()=>root.removeEntry(handle.name).catch(()=>{})}},
      async abort(){await writable.abort().catch(()=>{});await root.removeEntry(handle.name).catch(()=>{})}
    };
  }
  const chunks=[];
  return {async write(chunk){chunks.push(chunk)},async finish(){return {file:new Blob(chunks,{type:'video/mp4'}),cleanup:()=>{}}},async abort(){chunks.length=0}};
}

function createTransmuxSession() {
  if (!window.muxjs?.mp4?.Transmuxer) throw new Error('MP4 변환 모듈을 불러오지 못했습니다.');
  const transmuxer = new window.muxjs.mp4.Transmuxer({remux:true,keepOriginalTimestamps:false});
  let pending = null;
  let outputs = [];
  transmuxer.on('data', segment => outputs.push({init:segment.initSegment,data:segment.data}));
  transmuxer.on('done', () => {
    if (!pending) return;
    const resolve = pending.resolve;
    pending = null;
    const completed = outputs;
    outputs = [];
    resolve(completed);
  });
  return {
    process(bytes) {
      if (pending) return Promise.reject(new Error('영상 변환 작업이 겹쳤습니다.'));
      return new Promise((resolve, reject) => {
        pending = {resolve, reject};
        try { transmuxer.push(bytes); transmuxer.flush(); }
        catch (error) { pending = null; outputs = []; reject(error); }
      });
    }
  };
}

function updateProgress(percent,title,message) {
  $('download').classList.add('show');
  $('progressBar').style.width = `${Math.max(0,Math.min(100,Number(percent)||0))}%`;
  $('downloadPercent').textContent = typeof percent === 'number' ? `${Math.round(percent)}%` : String(percent || '');
  $('downloadTitle').textContent = title;
  $('downloadMessage').textContent = message;
}

function updateBackgroundProgress(registration) {
  $('download').classList.add('show');
  $('downloadTitle').textContent = '백그라운드 다운로드 중';
  const downloadedMb = (registration.downloaded / 1024 / 1024).toFixed(1);
  if (registration.downloadTotal > 0) {
    const percent = Math.min(95, (registration.downloaded / registration.downloadTotal) * 95);
    $('progressBar').style.width = `${percent}%`;
    $('downloadPercent').textContent = `${Math.round(percent)}%`;
  } else {
    $('progressBar').style.width = '35%';
    $('downloadPercent').textContent = '실행 중';
  }
  $('downloadMessage').textContent = `${downloadedMb}MB 수신 · 다른 탭으로 이동하거나 화면을 꺼도 계속 받습니다.`;
}

function segmentRange(item) {
  if (!item.byteRange?.length) return null;
  const start = item.byteRange.offset || 0;
  return `bytes=${start}-${start+item.byteRange.length-1}`;
}

function buildBackgroundParts(media) {
  const parts = [];
  if (media.mapUrl) parts.push({ kind:'map', url:media.mapUrl, segmentIndex:-1, range:null });
  media.segments.forEach((item,index) => {
    parts.push({ kind:'segment', url:item.url, segmentIndex:index, range:segmentRange(item) });
  });
  return parts;
}

function backgroundRequest(part, jobId, idx) {
  const proxy = new URL('/api/media_proxy', location.origin);
  proxy.searchParams.set('url', part.url);
  proxy.searchParams.set('bgjob', jobId);
  proxy.searchParams.set('idx', String(idx));
  proxy.searchParams.set('kind', part.kind);
  if (part.segmentIndex >= 0) proxy.searchParams.set('sidx', String(part.segmentIndex));
  const headers = new Headers();
  if (part.range) headers.set('Range', part.range);
  return new Request(proxy.toString(), { method:'GET', headers, credentials:'same-origin', cache:'no-store' });
}

function monitorBackgroundFetch(bg, job) {
  state.backgroundJobId = job.id;
  updateBackgroundProgress(bg);
  bg.addEventListener('progress', () => {
    updateBackgroundProgress(bg);
    if (bg.result === 'failure') {
      showError(`백그라운드 다운로드 실패 (${bg.failureReason || 'unknown'})`);
    }
  });
}

async function startBackgroundDownload(media, stream) {
  const registration = await ensureBackgroundRegistration();
  if (!registration?.backgroundFetch || media.segments.length < 2) return false;

  const jobId = `video-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const parts = buildBackgroundParts(media);
  const requests = parts.map((part, index) => backgroundRequest(part, jobId, index));
  const job = {
    id: jobId,
    title: state.result?.title || 'video',
    quality: stream.quality || 'video',
    isFmp4: media.isFmp4,
    hasMap: Boolean(media.mapUrl),
    segments: media.segments.map((item) => ({ sequence:item.sequence, key:item.key || null })),
    partCount: parts.length,
    createdAt: Date.now(),
  };

  try {
    await navigator.storage?.persist?.().catch(() => false);
    const bg = await registration.backgroundFetch.fetch(jobId, requests, {
      title: `${job.title} · 백그라운드 다운로드`,
    });
    saveJob(job);
    monitorBackgroundFetch(bg, job);
    updateProgress('실행 중','백그라운드 다운로드 시작','이제 다른 탭으로 이동하거나 화면을 꺼도 다운로드는 계속됩니다.');
    return true;
  } catch (error) {
    console.warn('Background Fetch unavailable, using foreground fallback', error);
    return false;
  }
}

async function triggerFileDownload(file, fileName, cleanup) {
  const objectUrl = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => { URL.revokeObjectURL(objectUrl); cleanup?.(); }, 60000);
}

async function finalizeBackgroundJob(job, meta) {
  if (state.finalizing || document.hidden) return;
  state.finalizing = true;
  document.querySelectorAll('.save,.copy').forEach(button=>button.disabled=true);
  try {
    const rawFile = await getBackgroundRawFile(job.id);
    const encrypted = job.segments.some((segment) => Boolean(segment.key));
    const fileName = `${sanitizeFileName(job.title)}-${job.quality}.mp4`;

    if (job.isFmp4 && !encrypted) {
      updateProgress(99,'다운로드 완료','파일을 저장 목록으로 넘깁니다.');
      await triggerFileDownload(rawFile, fileName, () => cleanupBackgroundJob(job.id));
      clearJob();
      updateProgress(100,'저장 완료','다운로드 목록에서 MP4 파일을 확인하세요.');
      return;
    }

    const writer = await createWriter(fileName);
    const keyCache = new Map();
    const transmuxSession = job.isFmp4 ? null : createTransmuxSession();
    let wroteInit = false;

    try {
      for (let index=0; index<meta.parts.length; index++) {
        const part = meta.parts[index];
        let bytes = new Uint8Array(await rawFile.slice(part.offset, part.offset + part.length).arrayBuffer());

        if (part.kind === 'map') {
          await writer.write(bytes);
          wroteInit = true;
          continue;
        }

        const segment = job.segments[part.segmentIndex];
        if (!segment) throw new Error('세그먼트 메타데이터가 없습니다.');
        if (segment.key) {
          bytes = await decryptAes128(bytes,{...segment.key,sequence:segment.sequence},keyCache,new AbortController().signal);
        }

        if (job.isFmp4) {
          await writer.write(bytes);
        } else {
          const outputs = await transmuxSession.process(bytes);
          if (!outputs.length) throw new Error(`${part.segmentIndex+1}번째 영상 조각을 MP4로 변환하지 못했습니다.`);
          for (const output of outputs) {
            if (!wroteInit && output.init?.byteLength) { await writer.write(output.init); wroteInit=true; }
            if (output.data?.byteLength) await writer.write(output.data);
          }
        }

        const percent = 95 + ((index + 1) / meta.parts.length) * 4;
        updateProgress(percent,'MP4 마무리 중',`${index+1} / ${meta.parts.length} 조각 로컬 변환`);
      }

      const completed = await writer.finish();
      await triggerFileDownload(completed.file, fileName, () => {
        completed.cleanup?.();
        cleanupBackgroundJob(job.id);
      });
      clearJob();
      updateProgress(100,'저장 완료','다운로드 목록에서 MP4 파일을 확인하세요.');
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
  } catch (error) {
    showError(error.message || '백그라운드 다운로드 마무리에 실패했습니다.');
    updateProgress(0,'마무리 실패',error.message || '파일 변환에 실패했습니다.');
  } finally {
    state.finalizing = false;
    document.querySelectorAll('.save,.copy').forEach(button=>button.disabled=false);
  }
}

async function restoreBackgroundJob() {
  const job = loadJob();
  if (!job) return;
  state.backgroundJobId = job.id;
  $('result').classList.add('show');
  $('videoTitle').textContent = job.title || '영상';
  $('videoCode').textContent = 'BG';

  const meta = await readBackgroundMeta(job.id);
  if (meta?.status === 'downloaded') {
    updateProgress(96,'백그라운드 다운로드 완료','네트워크 수신이 끝났습니다. MP4 저장을 마무리합니다.');
    await finalizeBackgroundJob(job, meta);
    return;
  }
  if (meta?.status === 'failed' || meta?.status === 'aborted') {
    showError(`백그라운드 다운로드 ${meta.status === 'aborted' ? '취소됨' : '실패'}${meta.failureReason ? ` (${meta.failureReason})` : ''}`);
    clearJob();
    return;
  }

  const registration = await ensureBackgroundRegistration();
  const bg = await registration?.backgroundFetch?.get(job.id).catch(() => null);
  if (bg) {
    monitorBackgroundFetch(bg, job);
    return;
  }

  updateProgress('확인 중','백그라운드 작업 확인 중','다운로드 완료 상태를 확인하고 있습니다.');
}

async function fetchSegmentBytes(item, signal) {
  const headers = {};
  const range = segmentRange(item);
  if (range) headers.Range = range;
  const response = await fetchMedia(item.url,{signal,headers});
  return new Uint8Array(await response.arrayBuffer());
}

function createPrefetchWindow(segments, signal, concurrency = SEGMENT_PREFETCH) {
  let nextIndex = 0;
  const pending = new Map();
  const fill = () => {
    while (nextIndex < segments.length && pending.size < concurrency) {
      const index = nextIndex++;
      pending.set(index, fetchSegmentBytes(segments[index], signal));
    }
  };
  return {
    async take(index) {
      fill();
      const task = pending.get(index) || fetchSegmentBytes(segments[index], signal);
      try { return await task; }
      finally { pending.delete(index); fill(); }
    },
    fill,
  };
}

async function downloadForeground(media, stream, controller) {
  const fileName = `${sanitizeFileName(state.result?.title)}-${stream.quality || 'video'}.mp4`;
  let writer = await createWriter(fileName);
  try {
    let wroteInit = false;
    const keyCache = new Map();
    const transmuxSession = media.isFmp4 ? null : createTransmuxSession();
    if (media.mapUrl) {
      const mapResponse = await fetchMedia(media.mapUrl,{signal:controller.signal});
      await writer.write(new Uint8Array(await mapResponse.arrayBuffer()));
      wroteInit = true;
    }

    const prefetch = createPrefetchWindow(media.segments, controller.signal, SEGMENT_PREFETCH);
    prefetch.fill();
    updateProgress(2,'MP4 저장 중',`${SEGMENT_PREFETCH}개씩 미리 받아 처리합니다. 총 ${media.segments.length}조각`);

    for (let index=0; index<media.segments.length; index++) {
      const item = media.segments[index];
      let bytes = await prefetch.take(index);
      if (item.key) bytes = await decryptAes128(bytes,{...item.key,sequence:item.sequence},keyCache,controller.signal);

      if (media.isFmp4) {
        await writer.write(bytes);
      } else {
        const parts = await transmuxSession.process(bytes);
        if (!parts.length) throw new Error(`${index+1}번째 영상 조각을 MP4로 변환하지 못했습니다.`);
        for (const part of parts) {
          if (!wroteInit && part.init?.byteLength) { await writer.write(part.init); wroteInit=true; }
          if (part.data?.byteLength) await writer.write(part.data);
        }
      }
      const percent = ((index+1)/media.segments.length)*96;
      updateProgress(percent,'MP4 저장 중',`${index+1} / ${media.segments.length} 조각 처리 완료`);
    }

    updateProgress(98,'파일 마무리 중','브라우저 저장 파일을 준비합니다.');
    const completed = await writer.finish(); writer=null;
    await triggerFileDownload(completed.file, fileName, completed.cleanup);
    updateProgress(100,'저장 완료','다운로드 목록에서 MP4 파일을 확인하세요.');
  } finally {
    if (writer) await writer.abort().catch(()=>{});
  }
}

async function downloadStream(stream) {
  if (state.abortController || state.backgroundJobId) return;
  const controller = new AbortController(); state.abortController = controller;
  document.querySelectorAll('.save,.copy').forEach(button=>button.disabled=true);
  updateProgress(1,'목록 확인 중','선택한 화질의 재생 목록을 불러옵니다.');
  try {
    let playlistUrl = stream.url;
    let response = await fetchMedia(playlistUrl,{signal:controller.signal});
    let text = await response.text();
    if (!text.includes('#EXTM3U')) throw new Error('올바른 HLS 재생 목록이 아닙니다.');
    if (text.includes('#EXT-X-STREAM-INF')) {
      const variants = parseMaster(text,playlistUrl);
      if (!variants.length) throw new Error('화질 목록을 해석하지 못했습니다.');
      playlistUrl = variants[0].url;
      response = await fetchMedia(playlistUrl,{signal:controller.signal});
      text = await response.text();
    }
    const media = parseMediaPlaylist(text,playlistUrl);
    if (!media.segments.length) throw new Error('다운로드할 영상 조각이 없습니다.');

    if (await startBackgroundDownload(media, stream)) return;
    await downloadForeground(media, stream, controller);
  } catch (error) {
    if (error?.name !== 'AbortError') controller.abort();
    if (error?.name === 'AbortError') updateProgress(0,'저장 취소됨','사용자가 작업을 취소했습니다.');
    else { updateProgress(0,'저장 실패',error.message || '영상을 저장하지 못했습니다.'); showError(error.message || '영상을 저장하지 못했습니다.'); }
  } finally {
    state.abortController=null;
    document.querySelectorAll('.save,.copy').forEach(button=>button.disabled=false);
  }
}

async function cancelActiveDownload() {
  if (state.backgroundJobId) {
    const jobId = state.backgroundJobId;
    const registration = await ensureBackgroundRegistration();
    const bg = await registration?.backgroundFetch?.get(jobId).catch(() => null);
    await bg?.abort().catch(() => false);
    clearJob();
    await cleanupBackgroundJob(jobId);
    updateProgress(0,'저장 취소됨','백그라운드 다운로드를 취소했습니다.');
    return;
  }
  state.abortController?.abort();
}

$('analyzeForm').addEventListener('submit',analyze);
$('cancelButton').addEventListener('click',cancelActiveDownload);

navigator.serviceWorker?.addEventListener('message', async (event) => {
  const job = loadJob();
  if (!job || event.data?.jobId !== job.id) return;
  if (event.data?.type === 'BG_FETCH_DONE' && !document.hidden) {
    const meta = await readBackgroundMeta(job.id);
    if (meta?.status === 'downloaded') await finalizeBackgroundJob(job, meta);
  } else if (event.data?.type === 'BG_FETCH_FAILED') {
    showError(`백그라운드 다운로드 실패${event.data?.reason ? ` (${event.data.reason})` : ''}`);
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) restoreBackgroundJob();
});

ensureBackgroundRegistration().finally(() => restoreBackgroundJob());