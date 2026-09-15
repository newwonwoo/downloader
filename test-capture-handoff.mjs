import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const allowedMatch = app.match(/function allowedImportedHls\(v\)\{[\s\S]*?\}\s*function importedQuality/);
assert.ok(allowedMatch, 'allowedImportedHls contract must exist');
const allowedSource = allowedMatch[0].replace(/\s*function importedQuality[\s\S]*$/, '');
// eslint-disable-next-line no-eval
eval(`const HLS_IMPORT_HOSTS=['surrit.com','nineyu.com'];${allowedSource};globalThis.__allowedImportedHls=allowedImportedHls`);

assert.equal(globalThis.__allowedImportedHls('https://surrit.com/a/video.m3u8'), 'https://surrit.com/a/video.m3u8');
assert.equal(globalThis.__allowedImportedHls('https://cdn.nineyu.com/x/master.m3u8?token=1'), 'https://cdn.nineyu.com/x/master.m3u8?token=1');
assert.equal(globalThis.__allowedImportedHls('http://surrit.com/a/video.m3u8'), null);
assert.equal(globalThis.__allowedImportedHls('https://evil.example/a/video.m3u8'), null);
assert.equal(globalThis.__allowedImportedHls('https://surrit.com/a/video.mp4'), null);

const captureStart = app.indexOf('function importAndroidCapture()');
const captureEnd = app.indexOf('function browserHandoffCode()', captureStart);
assert.ok(captureStart >= 0 && captureEnd > captureStart, 'Android capture import function must exist');
const captureBody = app.slice(captureStart, captureEnd);
assert.match(captureBody, /p\.get\('capture'\)!=='1'/);
assert.match(captureBody, /p\.get\('stream'\)/);
assert.match(captureBody, /resolver:'android-capture-v1'/);
assert.doesNotMatch(captureBody, /analyzeUrl\(/, 'direct capture must bypass source-page resolver');
assert.doesNotMatch(captureBody, /video-resolve/, 'direct capture must not call /resolve');

const domReady = app.slice(app.indexOf("window.addEventListener('DOMContentLoaded'"));
assert.ok(domReady.indexOf('importAndroidCapture()') < domReady.indexOf('sharedEntry()'), 'capture handoff must be handled before shared URL analysis');
console.log('Android capture handoff contract OK');
