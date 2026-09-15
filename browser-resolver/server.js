'use strict';

const http = require('http');
const { URL } = require('url');
const chromiumModule = require('@sparticuz/chromium');
const sparticuz = chromiumModule.default || chromiumModule;
const { chromium } = require('playwright-core');

const PORT = Number(process.env.PORT || 10000);
const SOURCE_HOSTS = new Set(['njavtv.com', 'www.njavtv.com']);
const MEDIA_SUFFIXES = ['surrit.com', 'nineyu.com'];
const MAX_BODY = 8192;
const BLOCK_RE = /cf-chl-|just a moment|verify you are human|checking your browser|challenge-platform|잠시만 기다리십시오/i;
let browserPromise = null;

function validSource(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'https:' || !SOURCE_HOSTS.has(u.hostname) || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}
function validMedia(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!MEDIA_SUFFIXES.some(s => host === s || host.endsWith('.' + s))) return null;
    if (!/\.m3u8(?:$|\?)/i.test(u.href)) return null;
    return u.href;
  } catch { return null; }
}
async function getBrowser() {
  if (!browserPromise) {
    const executablePath = await sparticuz.executablePath();
    const args = Array.isArray(sparticuz.args) ? sparticuz.args : [];
    console.log(`CHROMIUM path=${executablePath} args=${args.length}`);
    browserPromise = chromium.launch({
      args: [...args, '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'],
      executablePath,
      headless: true,
    }).catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}
async function waitChallenge(page, maxMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const html = await page.content().catch(() => '');
    const title = await page.title().catch(() => '');
    if (!BLOCK_RE.test(html) && !BLOCK_RE.test(title)) return false;
    await page.waitForTimeout(1500);
  }
  return true;
}
async function resolvePage(pageUrl) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 412, height: 915 },
    extraHTTPHeaders: {
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'upgrade-insecure-requests': '1',
    },
  });
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] }); } catch {}
    try { Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l' }); } catch {}
  });
  const page = await context.newPage();
  const found = new Set();
  const capture = value => { const v = validMedia(value); if (v) found.add(v); };
  page.on('request', req => capture(req.url()));
  page.on('response', res => capture(res.url()));
  let status = 0;
  let title = 'video';
  try {
    const target = new URL(pageUrl);
    const origin = `${target.protocol}//${target.host}/`;
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
    await waitChallenge(page, 10000);
    const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = response ? response.status() : 0;
    const blockedAfterWait = await waitChallenge(page, 15000);
    await page.waitForTimeout(2500);
    title = (await page.title().catch(() => 'video')) || 'video';
    const urls = await page.evaluate(() => {
      const out = [];
      for (const v of document.querySelectorAll('video')) {
        if (v.currentSrc) out.push(v.currentSrc);
        if (v.src) out.push(v.src);
        try { void v.play(); } catch {}
      }
      for (const e of performance.getEntriesByType('resource')) if (e.name) out.push(e.name);
      return out;
    }).catch(() => []);
    urls.forEach(capture);
    if (!found.size && !blockedAfterWait) {
      const video = page.locator('video').first();
      if (await video.count()) {
        await video.click({ force: true, timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(5000);
      }
    }
    const html = await page.content().catch(() => '');
    const blocked = blockedAfterWait || BLOCK_RE.test(html) || BLOCK_RE.test(title);
    return { ok: found.size > 0, status, blocked, title, streams: [...found].slice(0, 12) };
  } finally {
    await context.close().catch(() => {});
  }
}
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, mode: 'browser-network-resolver-v2' });
  if (req.method !== 'POST' || req.url !== '/resolve') return json(res, 404, { ok: false });
  let raw = '';
  req.on('data', chunk => { raw += chunk; if (raw.length > MAX_BODY) req.destroy(); });
  req.on('end', async () => {
    try {
      const data = JSON.parse(raw || '{}');
      const pageUrl = validSource(data.url);
      if (!pageUrl) return json(res, 400, { ok: false, code: 'BAD_URL' });
      const result = await resolvePage(pageUrl);
      return json(res, result.ok ? 200 : 409, result);
    } catch (error) {
      browserPromise = null;
      console.error('BROWSER_FAILED', error && (error.stack || error.message || String(error)));
      return json(res, 502, {
        ok: false,
        code: 'BROWSER_FAILED',
        errorType: String(error && error.name || 'Error'),
        message: String(error && error.message || error || 'Error').slice(0, 500),
      });
    }
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`browser resolver listening on ${PORT}`));
