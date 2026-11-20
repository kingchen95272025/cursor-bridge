'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {applyProxy, restoreProxy, proxyState} = require('../lib/settings.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-settings-'));
  const settings = path.join(dir, 'settings.json');
  const journal = path.join(dir, 'settings-journal.json');
  fs.writeFileSync(settings, [
    '{',
    '  // keep this comment',
    '  "editor.fontSize": 14,',
    '  "http.proxy": "http://old:1",',
    '  "custom.key": true',
    '}',
    ''
  ].join('\n'));
  return {dir, settings, journal};
}

test('写入代理并保留 JSONC 注释，还原后回到原值', () => {
  const {settings, journal} = fixture();
  applyProxy(settings, journal, 'http://127.0.0.1:58160');
  const applied = fs.readFileSync(settings, 'utf8');
  assert.match(applied, /keep this comment/);
  assert.match(applied, /"http\.proxy": "http:\/\/127\.0\.0\.1:58160"/);
  assert.match(applied, /"cursor\.general\.disableHttp2": true/);
  assert.ok(fs.existsSync(journal));

  assert.deepEqual(proxyState(settings, journal, 'http://127.0.0.1:58160').active, true);

  restoreProxy(journal);
  const restored = fs.readFileSync(settings, 'utf8');
  assert.match(restored, /"http\.proxy": "http:\/\/old:1"/);
  assert.match(restored, /keep this comment/);
  assert.equal(fs.existsSync(journal), false);
});

test('还原时保留期间发生的外部修改', () => {
  const {settings, journal} = fixture();
  applyProxy(settings, journal, 'http://127.0.0.1:58160');
  const edited = fs.readFileSync(settings, 'utf8').replace('"editor.fontSize": 14', '"editor.fontSize": 16');
  fs.writeFileSync(settings, edited);
  restoreProxy(journal);
  const restored = fs.readFileSync(settings, 'utf8');
  assert.match(restored, /"editor\.fontSize": 16/);
  assert.match(restored, /"http\.proxy": "http:\/\/old:1"/);
});

test('外部改动代理后再次写入会被拒绝', () => {
  const {settings, journal} = fixture();
  applyProxy(settings, journal, 'http://127.0.0.1:58160');
  fs.writeFileSync(settings, fs.readFileSync(settings, 'utf8').replace('127.0.0.1:58160', '10.0.0.1:9'));
  assert.throws(() => applyProxy(settings, journal, 'http://127.0.0.1:58160'), /changed externally/);
});