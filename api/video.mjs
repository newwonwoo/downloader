import chromiumBinary from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';

export const config = {
  maxDuration: 60,
};

const SOURCE_HOSTS = new Set(['njavtv.com', 'www.njavtv.com']);
const MEDIA_HOST_SUFFIXES = ['surrit.com', 'nineyu.com'];
const SESSION_TTL_MS = 12 * 60 * 1000;
const SESSION_CREATE_BUDGET_MS = 50_000;
const MAX_SESSIONS = 2;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SINGLE_RANGE_PATTERN = /^bytes=\d*-\d*$/i;

const runtime = globalThis.__NJAV_BROWSER_RUNTIME__ || {
  browserPromise: null,
  sessions: new Map(),
  pendingSessions: new Map(),
  sessionLock: Promise.resolve(),
};
runtime.sessions ||= new Map();
runtime.pendingSessions ||= new Map();
runtime.sessionLock ||= Promise.resolve();
for (const [key, value] of runtime.sessions.entries()) {
  if (value && typeof value.then === 'function') {
    runtime.sessions.delete(key);
    runtime.pendingSessions.set(key, value);
  }
}
globalThis.__NJAV_BROWSER_RUNTIME__ = runtime;

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function isAllowedSource(url) {
  return url.protocol === 'https:' && SOURCE_HOSTS.has(url.hostname.toLowerCase()) && url.toString().length <= 2048;
}

function isAllowedMediaHost(hostname) {
  const host = hostname.toLowerCase();
  return MEDIA_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function parseSourceUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!isAllowedSource(url)) throw new Error('INVALID_SOURCE');
  url.hash = '';
  return url;
}

function parseMediaUrl(value, session) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' || !isAllowedMediaHost(url.hostname) || url.toString().length > 4096) {
    throw new Error('INVALID_MEDIA');
  }
  const targetId = extractVideoId(url.toString());
  if (!targetId || !session.videoId || targetId.toLowerCase() !== session.videoId.toLowerCase()) {
    throw new Error('MEDIA_SESSION_MISMATCH');
  }
  return url;
}

function parseAttributes(line) {
  const attributes = {};
  const body = line.slice(line.indexOf(':') + 1);
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match;
  while ((match = pattern.exec(body))) {
    attributes[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  }
  return attributes;
}

export function parseMasterPlaylist(text, masterUrl) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = parseAttributes(lines[index]);
    const uri = lines.slice(index + 1).find((line) => !line.startsWith('#'));
    if (!uri) continue;

    try {
      const resolution = attrs.RESOLUTION || '';
      const [width, height] = resolution.split('x').map(Number);
      variants.push({
        quality: resolution || (height ? `${height}p` : '자동'),
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
        bandwidth: Number(attrs.BANDWIDTH || 0),
        url: new URL(uri, masterUrl).toString(),
      });
    } catch {}
  }

  return variants.sort((left, right) => (right.height - left.height) || (right.bandwidth - left.bandwidth));
}

export function extractVideoId(value) {
  return String(value || '').match(UUID_PATTERN)?.[0] || null;
}

function decodeHtml(value = '') {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/');
}

function stripTags(value = '') {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

export function parseNjavHtml(html, pageUrl) {
  const normalized = decodeHtml(String(html || ''));
  const title = stripTags(
    normalized.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
    normalized.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
    'video'
  ).replace(/\s*[-|]\s*nJAV.*$/i, '').trim();

  const videoId = extractVideoId(normalized);
  const directUrls = [];
  const pattern = /https?:\/\/[^\s"'<>\\]+?\.m3u8(?:\?[^\s"'<>\\]*)?/gi;
  for (const match of normalized.matchAll(pattern)) {
    try {
      const url = new URL(match[0], pageUrl).toString();
      if (!directUrls.includes(url)) directUrls.push(url);
    } catch {}
  }

  return {
    title: title || 'video',
    videoId,
    pageUrl,
    candidates: directUrls.map((url) => ({ quality: '자동', url, source: 'page' })),
    cloudflareDetected: /cf-chl-|cloudflare|just a moment/i.test(normalized),
  };
}

function remainingBudget(deadline, maximum, reserve = 0) {
  return Math.max(0, Math.min(maximum, deadline - Date.now() - reserve));
}

async function withSessionLock(task) {
  const previous = runtime.sessionLock || Promise.resolve();
  let release;
  runtime.sessionLock = new Promise((resolve) => {
    release = resolve;
  });
  await Promise.resolve(previous).catch(() => {});
  try {
    return await task();
  } finally {
    release();
  }
}

async function getBrowser() {
  if (!runtime.browserPromise) {
    runtime.browserPromise = (async () => {
      const executablePath = process.env.CHROME_EXECUTABLE_PATH || await chromiumBinary.executablePath();
      const browser = await playwrightChromium.launch({
        executablePath,
        args: [
          ...chromiumBinary.args,
          '--autoplay-policy=no-user-gesture-required',
          '--disable-dev-shm-usage',
          '--no-first-run',
        ],
        headless: true,
      });
      browser.on('disconnected', () => {
        runtime.browserPromise = null;
        runtime.sessions.clear();
        runtime.pendingSessions.clear();
      });
      return browser;
    })().catch((error) => {
      runtime.browserPromise = null;
      throw error;
    });
  }

  const browser = await runtime.browserPromise;
  if (!browser.isConnected()) {
    runtime.browserPromise = null;
    return getBrowser();
  }
  return browser;
}

async function fetchTextInPage(page, url, timeoutMs = 8_000) {
  return page.evaluate(async ({ targetUrl, requestTimeout }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const response = await fetch(targetUrl, {
        credentials: 'omit',
        cache: 'default',
        mode: 'cors',
        signal: controller.signal,
      });
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type') || '',
        text: await response.text(),
      };
    } catch (error) {
      return { ok: false, status: 0, contentType: '', text: '', error: `${error.name}: ${error.message}` };
    } finally {
      clearTimeout(timer);
    }
  }, { targetUrl: url, requestTimeout: Math.max(500, timeoutMs) });
}

async function fetchBinaryInPage(page, url, { range = null, timeoutMs = 20_000 } = {}) {
  return page.evaluate(async ({ targetUrl, requestRange, requestTimeout }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const headers = requestRange ? { Range: requestRange } : undefined;
      const response = await fetch(targetUrl, {
        credentials: 'omit',
        cache: 'default',
        mode: 'cors',
        headers,
        signal: controller.signal,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type') || 'application/octet-stream',
        contentRange: response.headers.get('content-range') || '',
        acceptRanges: response.headers.get('accept-ranges') || '',
        contentLength: bytes.byteLength,
        base64: btoa(binary),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        contentType: 'application/octet-stream',
        contentRange: '',
        acceptRanges: '',
        contentLength: 0,
        base64: '',
        error: `${error.name}: ${error.message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }, {
    targetUrl: url,
    requestRange: range,
    requestTimeout: Math.max(500, timeoutMs),
  });
}

async function closeSession(session) {
  try {
    await session?.context?.close();
  } catch {}
}

function isUsableSession(session) {
  return Boolean(
    session &&
    session.page &&
    !session.page.isClosed() &&
    (Date.now() - session.lastUsed) < SESSION_TTL_MS
  );
}

async function trimSessions(exceptKey) {
  for (const [key, session] of runtime.sessions.entries()) {
    if (key === exceptKey || isUsableSession(session)) continue;
    runtime.sessions.delete(key);
    await closeSession(session);
  }

  const candidates = [...runtime.sessions.entries()]
    .filter(([key]) => key !== exceptKey)
    .sort((left, right) => (left[1].lastUsed || 0) - (right[1].lastUsed || 0));

  while ((runtime.sessions.size + runtime.pendingSessions.size) >= MAX_SESSIONS && candidates.length) {
    const [key, session] = candidates.shift();
    runtime.sessions.delete(key);
    await closeSession(session);
  }

  return (runtime.sessions.size + runtime.pendingSessions.size) < MAX_SESSIONS;
}

async function createSession(sourceUrl) {
  const deadline = Date.now() + SESSION_CREATE_BUDGET_MS;
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
    userAgent: UA,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const observedManifests = [];

  page.on('request', (request) => {
    const url = request.url();
    if (/\.m3u8(?:\?|$)/i.test(url) && !observedManifests.includes(url)) observedManifests.push(url);
  });

  try {
    await page.route('**/*', async (route) => {
      const type = route.request().resourceType();
      if (type === 'font' || type === 'image') return route.abort();
      return route.continue();
    });

    const navigationTimeout = remainingBudget(deadline, 35_000, 12_000);
    if (navigationTimeout < 1_000) throw new Error('STREAM_NOT_FOUND');
    try {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
    } catch (error) {
      if (error?.name !== 'TimeoutError' || remainingBudget(deadline, 10_000, 6_000) < 1_000) throw error;
    }

    const discoveryDeadline = deadline - 8_000;
    let masterUrl = null;
    while (Date.now() < discoveryDeadline && !masterUrl) {
      masterUrl = await page.evaluate(() => {
        const value = globalThis.hls?.url || globalThis.hls?.source || globalThis.hls?.src;
        if (typeof value === 'string' && value.includes('.m3u8')) return value;
        const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
        return resources.find((item) => /\.m3u8(?:\?|$)/i.test(item)) || null;
      }).catch(() => null);
      masterUrl ||= observedManifests.find((item) => /playlist\.m3u8(?:\?|$)/i.test(item)) || observedManifests[0] || null;
      if (!masterUrl) await page.waitForTimeout(Math.min(500, Math.max(1, discoveryDeadline - Date.now())));
    }

    const pageInfo = await page.evaluate(() => ({
      title: (document.querySelector('h1')?.textContent || document.title || 'video').replace(/\s+/g, ' ').trim(),
      body: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
    })).catch(() => ({ title: 'video', body: '' }));

    if (!masterUrl) {
      const challenged = /just a moment|verify you are human|checking your browser|cloudflare|security verification/i.test(`${pageInfo.title} ${pageInfo.body}`);
      const error = new Error(challenged ? 'SOURCE_BLOCKED' : 'STREAM_NOT_FOUND');
      error.pageTitle = pageInfo.title;
      throw error;
    }

    const masterTimeout = remainingBudget(deadline, 7_000, 2_000);
    if (masterTimeout < 500) throw new Error('MASTER_UNAVAILABLE');
    const master = await fetchTextInPage(page, masterUrl, masterTimeout);
    if (!master.ok || !master.text.includes('#EXTM3U')) throw new Error('MASTER_UNAVAILABLE');

    let variants = parseMasterPlaylist(master.text, masterUrl);
    if (!variants.length) {
      variants = [{ quality: '자동', width: 0, height: 0, bandwidth: 0, url: masterUrl }];
    }

    const variantTimeout = remainingBudget(deadline, 6_000, 1_000);
    if (variantTimeout < 500) throw new Error('STREAM_UNAVAILABLE');
    const checked = await Promise.all(variants.map(async (variant) => {
      const playlist = await fetchTextInPage(page, variant.url, variantTimeout);
      return {
        ...variant,
        available: playlist.ok && playlist.text.includes('#EXTM3U'),
        manifestType: playlist.text.includes('#EXTINF') ? 'media' : 'unknown',
      };
    }));
    const streams = checked.filter((item) => item.available);
    if (!streams.length) throw new Error('STREAM_UNAVAILABLE');

    const videoId = extractVideoId(masterUrl);
    if (!videoId) throw new Error('VIDEO_ID_NOT_FOUND');

    return {
      sourceUrl,
      page,
      context,
      title: pageInfo.title.replace(/\s*-\s*nJAV.*$/i, '').trim() || 'video',
      masterUrl,
      videoId,
      streams,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function getSession(sourceUrl, forceRefresh = false) {
  const key = sourceUrl.toString();

  while (true) {
    const decision = await withSessionLock(async () => {
      const existing = runtime.sessions.get(key);
      if (isUsableSession(existing) && !forceRefresh) {
        existing.lastUsed = Date.now();
        return { type: 'session', session: existing };
      }

      if (existing) {
        runtime.sessions.delete(key);
        await closeSession(existing);
      }

      const pendingForKey = runtime.pendingSessions.get(key);
      if (pendingForKey) return { type: 'wait', promise: pendingForKey };

      const hasSlot = await trimSessions(key);
      if (!hasSlot) {
        const pendingForCapacity = runtime.pendingSessions.values().next().value;
        if (pendingForCapacity) return { type: 'wait', promise: pendingForCapacity };
        throw new Error('SESSION_CAPACITY_UNAVAILABLE');
      }

      const promise = createSession(key);
      runtime.pendingSessions.set(key, promise);
      return { type: 'create', promise };
    });

    if (decision.type === 'session') return decision.session;

    if (decision.type === 'wait') {
      await decision.promise.catch(() => null);
      continue;
    }

    try {
      const created = await decision.promise;
      let retained = false;
      await withSessionLock(async () => {
        if (runtime.pendingSessions.get(key) === decision.promise) {
          runtime.pendingSessions.delete(key);
          runtime.sessions.set(key, created);
          retained = true;
        }
      });
      if (retained) return created;
      await closeSession(created);
    } catch (error) {
      await withSessionLock(async () => {
        if (runtime.pendingSessions.get(key) === decision.promise) runtime.pendingSessions.delete(key);
      });
      throw error;
    }
  }
}

async function handleAnalyze(request) {
  let sourceUrl;
  try {
    const body = await request.json();
    sourceUrl = parseSourceUrl(body?.url);
  } catch {
    return jsonResponse(400, { ok: false, code: 'INVALID_URL', message: 'NJAVTV의 https 영상 주소를 입력하세요.' });
  }

  try {
    const session = await getSession(sourceUrl);
    return jsonResponse(200, {
      ok: true,
      title: session.title,
      videoId: session.videoId,
      pageUrl: sourceUrl.toString(),
      streams: session.streams.map(({ quality, url, available, manifestType, bandwidth, width, height }) => ({
        quality,
        url,
        available,
        manifestType,
        bandwidth,
        width,
        height,
      })),
      limitations: ['DRM 스트림은 지원하지 않음', '저장이 허용된 영상만 사용'],
    });
  } catch (error) {
    const code = ['SOURCE_BLOCKED', 'STREAM_NOT_FOUND', 'MASTER_UNAVAILABLE', 'STREAM_UNAVAILABLE'].includes(error?.message)
      ? error.message
      : 'BROWSER_UNAVAILABLE';
    const messageByCode = {
      SOURCE_BLOCKED: '원본 사이트의 보안 확인을 통과하지 못했습니다.',
      STREAM_NOT_FOUND: '영상 재생 주소를 찾지 못했습니다.',
      MASTER_UNAVAILABLE: '영상 화질 목록을 불러오지 못했습니다.',
      STREAM_UNAVAILABLE: '현재 재생 가능한 화질이 없습니다.',
      BROWSER_UNAVAILABLE: '영상 분석 브라우저를 시작하지 못했습니다.',
    };
    return jsonResponse(code === 'SOURCE_BLOCKED' ? 409 : 502, {
      ok: false,
      code,
      message: messageByCode[code],
    });
  }
}

async function handleMedia(request) {
  const requestUrl = new URL(request.url);
  let sourceUrl;
  try {
    sourceUrl = parseSourceUrl(requestUrl.searchParams.get('source'));
  } catch {
    return jsonResponse(400, { ok: false, code: 'INVALID_SOURCE', message: '원본 영상 주소가 올바르지 않습니다.' });
  }

  const range = request.headers.get('range');
  if (range && !SINGLE_RANGE_PATTERN.test(range)) {
    return jsonResponse(416, { ok: false, code: 'INVALID_RANGE', message: '단일 바이트 범위만 지원합니다.' });
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const session = await getSession(sourceUrl, attempt === 1);
      const mediaUrl = parseMediaUrl(requestUrl.searchParams.get('url'), session);
      session.lastUsed = Date.now();
      const result = await fetchBinaryInPage(session.page, mediaUrl.toString(), { range });
      if (!result.ok || !result.base64) throw new Error('MEDIA_FETCH_FAILED');

      const bytes = Buffer.from(result.base64, 'base64');
      const headers = {
        'Content-Type': result.contentType || 'application/octet-stream',
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Vary': 'Range',
      };
      if (result.contentRange) headers['Content-Range'] = result.contentRange;
      if (result.acceptRanges) headers['Accept-Ranges'] = result.acceptRanges;
      else if (range) headers['Accept-Ranges'] = 'bytes';

      return new Response(bytes, {
        status: result.status === 206 ? 206 : 200,
        headers,
      });
    } catch (error) {
      if (attempt === 0) continue;
      return jsonResponse(502, {
        ok: false,
        code: 'MEDIA_FETCH_FAILED',
        message: '영상 조각을 불러오지 못했습니다. 다시 분석한 뒤 재시도하세요.',
      });
    }
  }

  return jsonResponse(502, { ok: false, code: 'MEDIA_FETCH_FAILED', message: '영상 조각을 불러오지 못했습니다.' });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    const url = new URL(request.url);
    if (request.method === 'POST') return handleAnalyze(request);
    if (request.method === 'GET' && url.searchParams.get('op') === 'media') return handleMedia(request);
    if (request.method === 'GET' && url.searchParams.get('op') === 'health') {
      return jsonResponse(200, {
        ok: true,
        browserWarm: Boolean(runtime.browserPromise),
        sessions: runtime.sessions.size,
        pendingSessions: runtime.pendingSessions.size,
      });
    }
    return jsonResponse(405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '지원하지 않는 요청입니다.' });
  },
};
