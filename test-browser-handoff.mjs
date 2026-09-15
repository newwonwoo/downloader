import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');

function element(value = '') {
  return {
    value,
    textContent: '',
    disabled: false,
    hidden: false,
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    parentElement: { hidden: false },
    addEventListener() {},
    setAttribute(name) { if (name === 'hidden') this.hidden = true; },
    removeAttribute(name) { if (name === 'hidden') this.hidden = false; },
  };
}

function run(hash) {
  const elements = {
    analyzeForm: element(),
    analyzeButton: element(),
    status: element(),
    statusTitle: element(),
    statusText: element(),
    error: element(),
    result: element(),
    download: element(),
    progressBar: element(),
    downloadPercent: element(),
    downloadTitle: element(),
    downloadMessage: element(),
    pageUrl: element('https://njavtv.com/ko/example'),
    copyHelper: element(),
    helperPanel: element(),
  };
  elements.progressBar.parentElement = { hidden: false };

  const listeners = new Map();
  let rendered = null;
  const location = {
    hash,
    origin: 'https://downloader-web-1gqu.onrender.com',
    pathname: '/',
    search: '',
  };
  const window = {
    location,
    history: { replaceState() { location.hash = ''; } },
    renderResult(data) { rendered = data; },
    warmDownloaderWorker() { return Promise.resolve(true); },
    addEventListener(name, callback) { listeners.set(name, callback); },
  };

  const context = {
    window,
    document: { getElementById(id) { return elements[id] || null; } },
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
    fetch: async () => { throw new Error('not used'); },
  };
  vm.runInNewContext(source, context, { filename: 'app.js' });
  listeners.get('DOMContentLoaded')?.();
  return { rendered, elements, location };
}

const hls = 'https://surrit.com/12345678-1234-1234-1234-123456789abc/1280x720/video.m3u8?token=x';
const sourcePage = 'https://njavtv.com/ko/some-video';
const good = run(`#${new URLSearchParams({ hls, title: 'Sample title', source: sourcePage })}`);
assert(good.rendered, 'valid imported HLS must render');
assert.equal(good.rendered.resolver, 'browser-handoff-v2');
assert.equal(good.rendered.streams[0].url, hls);
assert.equal(good.rendered.streams[0].quality, '1280x720');
assert.equal(good.rendered.streams[0].height, 720);
assert.equal(good.rendered.pageUrl, sourcePage);
assert.equal(good.elements.pageUrl.value, sourcePage);
assert.equal(good.location.hash, '', 'sensitive fragment must be removed after import');

const bad = run(`#${new URLSearchParams({ hls: 'https://evil.example/video.m3u8', source: sourcePage })}`);
assert.equal(bad.rendered, null, 'non-allowlisted HLS host must not render');

console.log('PASS browser handoff: allowlisted HLS imports into current renderer and fragment is cleared');
