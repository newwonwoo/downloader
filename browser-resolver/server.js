'use strict';

const http = require('http');
const { URL } = require('url');
const sparticuz = require('@sparticuz/chromium');
const { chromium } = require('playwright-core');

const PORT = Number(process.env.PORT || 10000);
const SOURCE_HOSTS = new Set(['njavtv.com', 'www.njavtv.com']);
const MEDIA_SUFFIXES = ['surrit.com', 'nineyu.com'];
const MAX_BODY = 8192;
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
      args: [...args, '--autoplay-policy=no-user-gesture-required'],
      executablePath,
      headless: true,
    }).catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}
async function resolvePage(pageUrl) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 412, height: 915 },
    userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S937N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  });
  const page = await context.newPage();
  const found = new Set();
  const capture = value => { const v = validMedia(value); if (v) found.add(v); };
  page.on('request', req => capture(req.url()));
  page.on('response', res => capture(res.url()));
  let status = 0;
  let title = 'video';
  try {
    const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    status = response ? response.status() : 0;
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
    if (!found.size) {
      const video = page.locator('video').first();
      if (await video.count()) {
        await video.click({ force: true, timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(5000);
      }
    }
    const html = await page.content().catch(() => '');
    const blocked = /cf-chl-|just a moment|verify you are human|checking your browser|challenge-platform/i.test(html);
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
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, mode: 'browser-network-resolver-v1' });
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
