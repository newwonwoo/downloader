(() => {
  const nativeFetch = window.fetch.bind(window);
  const ADAPTER = '/api/downloader';
  const MEDIA_CHUNK_BYTES = 2 * 1024 * 1024;
  const FALLBACK_CODES = new Set([
    'SOURCE_BLOCKED',
    'SOURCE_TIMEOUT',
    'SOURCE_ERROR',
    'STREAM_NOT_FOUND',
    'STREAM_UNAVAILABLE',
    'MASTER_UNAVAILABLE',
    'BROWSER_UNAVAILABLE',
  ]);

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input?.url || '';
  }

  function adapterUrl(stage, extra = {}) {
    const url = new URL(ADAPTER, window.location.origin);
    url.searchParams.set('stage', stage);
    for (const [key, value] of Object.entries(extra)) {
      if (value != null && value !== '') url.searchParams.set(key, value);
    }
    return `${url.pathname}${url.search}`;
  }

  function isPath(value, path) {
    try {
      return new URL(value, window.location.origin).pathname === path;
    } catch {
      return false;
    }
  }

  function mediaProxyUrl(target) {
    const proxy = new URL('/api/media_proxy', window.location.origin);
    proxy.searchParams.set('url', target || '');
    return `${proxy.pathname}${proxy.search}`;
  }

  function parseByteRange(value) {
    const match = String(value || '').match(/^bytes=(\d+)-(\d*)$/i);
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : null;
    if (!Number.isSafeInteger(start) || start < 0) return null;
    if (end != null && (!Number.isSafeInteger(end) || end < start)) return null;
    return { start, end };
  }

  function parseContentRange(value) {
    const match = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!match) return null;
    return {
      start: Number(match[1]),
      end: Number(match[2]),
      total: match[3] === '*' ? null : Number(match[3]),
    };
  }

  async function fetchMediaProxy(target, init = {}) {
    const proxy = mediaProxyUrl(target);
    const originalHeaders = new Headers(init.headers || {});
    const requested = parseByteRange(originalHeaders.get('Range'));

    if (/\.m3u8(?:$|\?)/i.test(target)) {
      return nativeFetch(proxy, init);
    }

    let cursor = requested?.start ?? 0;
    const requestedEnd = requested?.end ?? null;
    const chunks = [];
    let contentType = 'application/octet-stream';
    let totalSize = null;
    let loops = 0;

    while (loops++ < 10000) {
      const upper = requestedEnd == null
        ? cursor + MEDIA_CHUNK_BYTES - 1
        : Math.min(requestedEnd, cursor + MEDIA_CHUNK_BYTES - 1);
      const headers = new Headers(originalHeaders);
      headers.set('Range', `bytes=${cursor}-${upper}`);

      const response = await nativeFetch(proxy, { ...init, headers });
      if (!(response.ok || response.status === 206)) return response;

      contentType = response.headers.get('content-type') || contentType;
      const range = parseContentRange(response.headers.get('content-range'));
      const bytes = await response.arrayBuffer();
      chunks.push(bytes);

      if (range) {
        totalSize = range.total;
        if (requestedEnd != null && range.end >= requestedEnd) break;
        if (totalSize != null && range.end + 1 >= totalSize) break;
        if (!bytes.byteLength) break;
        cursor = range.end + 1;
        continue;
      }

      if (response.status === 200 || bytes.byteLength < MEDIA_CHUNK_BYTES) break;
      cursor += bytes.byteLength;
    }

    if (loops >= 10000) throw new Error('미디어 분할 다운로드 횟수가 비정상적으로 많습니다.');

    const blob = new Blob(chunks, { type: contentType });
    const headers = new Headers({
      'Content-Type': contentType,
      'Content-Length': String(blob.size),
      'X-Media-Chunked': '1',
    });
    if (requested) {
      const end = requested.start + blob.size - 1;
      headers.set('Content-Range', `bytes ${requested.start}-${end}/${totalSize ?? '*'}`);
      headers.set('Accept-Ranges', 'bytes');
    }
    return new Response(blob, { status: requested ? 206 : 200, headers });
  }

  async function readCode(response) {
    if (!response) return null;
    try {
      const body = await response.clone().json();
      return body?.code || null;
    } catch {
      return null;
    }
  }

  async function shouldFallback(response) {
    if (!response) return true;
    if (response.ok) return false;
    const code = await readCode(response);
    return !code || FALLBACK_CODES.has(code) || code === 'TARGET_NOT_VERIFIED';
  }

  async function tryEndpoint(endpoint, init) {
    try {
      return await nativeFetch(endpoint, init);
    } catch {
      return null;
    }
  }

  window.fetch = async (input, init = {}) => {
    const value = requestUrl(input);

    if (isPath(value, '/api/video-fetch')) {
      const original = new URL(value, window.location.origin);
      return fetchMediaProxy(original.searchParams.get('url') || '', init);
    }

    if (!isPath(value, '/api/video-resolve')) {
      return nativeFetch(input, init);
    }

    const direct = await tryEndpoint(adapterUrl('direct'), init);
    if (!(await shouldFallback(direct))) return direct;

    const verified = await tryEndpoint(adapterUrl('verified'), init);
    if (!(await shouldFallback(verified))) return verified;

    const browser = await tryEndpoint(adapterUrl('browser'), init);
    if (browser) return browser;

    throw new TypeError('영상 분석 서버에 연결하지 못했습니다.');
  };
})();