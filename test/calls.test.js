'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {CallStore, dayKey} = require('../src/calls.js');

function store() {
  return new CallStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-calls-')));
}

test('调用记录按时间倒序读取', () => {
  const calls = store();
  const now = Date.now();
  calls.record({ts: now - 1000, providerId: 'a', model: 'a/m', status: 200, durationMs: 10, totalTokens: 3});
  calls.record({ts: now, providerId: 'a', model: 'a/m', status: 502, durationMs: 20, error: 'boom'});
  const rows = calls.list({limit: 10});
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ts, now);
  assert.equal(rows[1].ts, now - 1000);
  const summary = calls.summary();
  assert.equal(summary.calls, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.tokens, 3);
  assert.equal(summary.averageMs, 15);
});

test('超过保留天数的文件会被清理', () => {
  const calls = store();
  const stale = path.join(calls.dir, '2020-01-01.jsonl');
  fs.writeFileSync(stale, '{"ts":1}\n');
  const result = calls.prune({days: 30});
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(stale), false);
});

test('当天文件名格式稳定', () => {
  assert.match(dayKey(new Date(2026, 0, 2).getTime()), /^2026-01-02$/);
});