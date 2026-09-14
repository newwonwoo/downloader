const JOBS_DIR = 'downloader-bg';
const RELAY_MAGIC = 'NJR1';
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function safeJobId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
}

async function getJobDirectory(jobId, create = true) {
  const root = await navigator.storage.getDirectory();
  const jobs = await root.getDirectoryHandle(JOBS_DIR, { create });
  return jobs.getDirectoryHandle(safeJobId(jobId), { create });
}

async function writeJson(dir, name, value) {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(value));
  await writable.close();
}

async function notifyClients(message) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) client.postMessage(message);
}

function concatBytes(left, right) {
  if (!left?.byteLength) return right;
  if (!right?.byteLength) return left;
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

async function readChunk(reader, state) {
  const result = await reader.read();
  if (result.done) throw new Error('relay response ended early');
  state.buffer = concatBytes(state.buffer, result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value));
}

async function takeExact(reader, state, length) {
  while (state.buffer.byteLength < length) await readChunk(reader, state);
  const out = state.buffer.slice(0, length);
  state.buffer = state.buffer.slice(length);
  return out;
}

async function pipeExact(reader, state, length, writable, position) {
  let remaining = length;
  let writePosition = position;
  while (remaining > 0) {
    if (!state.buffer.byteLength) await readChunk(reader, state);
    const size = Math.min(remaining, state.buffer.byteLength);
    const piece = state.buffer.slice(0, size);
    await writable.write({ type: 'write', position: writePosition, data: piece });
    state.buffer = state.buffer.slice(size);
    writePosition += size;
    remaining -= size;
  }
  return writePosition;
}

function uint16(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0, false);
}

function uint32(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
}

async function ingestRelayResponse(response, requestUrl, writable, startPosition, parts) {
  if (!response.ok) throw new Error(`relay response ${response.status}`);
  if (!response.body) throw new Error('relay response body missing');

  const reader = response.body.getReader();
  const state = { buffer: new Uint8Array(0) };
  const header = await takeExact(reader, state, 6);
  const magic = String.fromCharCode(header[0], header[1], header[2], header[3]);
  if (magic !== RELAY_MAGIC) throw new Error('relay response format mismatch');

  const count = uint16(header.slice(4, 6));
  if (!count || count > 32) throw new Error('relay frame count invalid');

  const kind = requestUrl.searchParams.get('kind') || 'bundle';
  const start = Number(requestUrl.searchParams.get('start') || 0);
  let position = startPosition;

  for (let frameIndex = 0; frameIndex < count; frameIndex++) {
    const length = uint32(await takeExact(reader, state, 4));
    if (!length || length > MAX_FRAME_BYTES) throw new Error('relay frame length invalid');
    const offset = position;
    position = await pipeExact(reader, state, length, writable, position);
    parts.push({
      kind: kind === 'map' ? 'map' : 'segment',
      segmentIndex: kind === 'map' ? -1 : start + frameIndex,
      offset,
      length,
    });
  }

  await reader.cancel().catch(() => {});
  return position;
}

async function persistSuccessfulFetch(registration) {
  const dir = await getJobDirectory(registration.id, true);
  const rawHandle = await dir.getFileHandle('raw.bin', { create: true });
  const writable = await rawHandle.createWritable();

  try {
    const records = await registration.matchAll();
    records.sort((left, right) => {
      const a = Number(new URL(left.request.url).searchParams.get('idx') || 0);
      const b = Number(new URL(right.request.url).searchParams.get('idx') || 0);
      return a - b;
    });

    let position = 0;
    const parts = [];

    for (const record of records) {
      const requestUrl = new URL(record.request.url);
      const response = await record.responseReady;
      position = await ingestRelayResponse(response, requestUrl, writable, position, parts);
    }

    await writable.close();
    parts.sort((a, b) => {
      if (a.kind === 'map') return -1;
      if (b.kind === 'map') return 1;
      return a.segmentIndex - b.segmentIndex;
    });

    await writeJson(dir, 'meta.json', {
      status: 'downloaded',
      jobId: registration.id,
      bytes: position,
      parts,
      completedAt: Date.now(),
      transport: 'relay-v1',
    });

    await registration.updateUI({ title: '영상 다운로드 완료 · 사이트로 돌아가 저장을 마무리하세요' }).catch(() => {});
    await notifyClients({ type: 'BG_FETCH_DONE', jobId: registration.id });
  } catch (error) {
    await writable.abort().catch(() => {});
    await writeJson(dir, 'meta.json', {
      status: 'failed',
      jobId: registration.id,
      message: error?.message || '백그라운드 파일 저장 실패',
      completedAt: Date.now(),
    }).catch(() => {});
    await notifyClients({ type: 'BG_FETCH_FAILED', jobId: registration.id, message: error?.message || '' });
    throw error;
  }
}

async function persistFailure(registration, status) {
  const dir = await getJobDirectory(registration.id, true);
  await writeJson(dir, 'meta.json', {
    status,
    jobId: registration.id,
    failureReason: registration.failureReason || '',
    completedAt: Date.now(),
  });
  await notifyClients({ type: 'BG_FETCH_FAILED', jobId: registration.id, reason: registration.failureReason || status });
}

self.addEventListener('backgroundfetchsuccess', (event) => {
  event.waitUntil(persistSuccessfulFetch(event.registration));
});

self.addEventListener('backgroundfetchfail', (event) => {
  event.waitUntil(persistFailure(event.registration, 'failed'));
});

self.addEventListener('backgroundfetchabort', (event) => {
  event.waitUntil(persistFailure(event.registration, 'aborted'));
});

self.addEventListener('backgroundfetchclick', (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.focus();
    return self.clients.openWindow('/');
  })());
});
