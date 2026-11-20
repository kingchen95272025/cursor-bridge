'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The engine owns bridge.db. The extension never writes the schema; it only
// reads sizes and deletes trace rows older than the retention window. Queries
// are synchronous on purpose: every caller is either the console's explicit
// "measure" action or the service while the engine is stopped for VACUUM.
//
// Node 20 has no node:sqlite. The helper reports which driver is in use so the
// console can hide the database tab instead of failing halfway through.

const TABLES = [
  {name: 'conversations', category: '会话', label: '会话'},
  {name: 'messages', category: '会话', label: '消息', content: 'length(CAST(payload_json AS BLOB))'},
  {name: 'input_anchors', category: '会话', label: '输入锚点'},
  {name: 'checkpoint_messages', category: '会话', label: '检查点消息'},
  {name: 'blobs', category: '会话', label: '二进制块', content: 'length(data)'},
  {name: 'runs', category: '会话', label: '运行记录'},
  {name: 'tool_rounds', category: '工具', label: '工具回合'},
  {name: 'tool_round_calls', category: '工具', label: '工具调用'},
  {name: 'llm_calls', category: '调用', label: '模型调用'},
  {name: 'llm_call_requests', category: '调用', label: '调用请求'},
  {name: 'llm_call_response_chunks', category: '调用', label: '响应分块'},
  {name: 'model_configs', category: '调用', label: '模型配置'},
  {name: 'cursor_run_traces', category: '链路', label: '请求链路'},
  {name: 'service_settings', category: '设置', label: '服务设置'}
];

function driver() {
  try {
    require('node:sqlite');
    return {ok: true, driver: 'node:sqlite', detail: null};
  } catch (error) {
    return {ok: false, driver: null, detail: `当前运行时没有 node:sqlite（Node ${process.version}）`};
  }
}

function openReadOnly(file) {
  const {DatabaseSync} = require('node:sqlite');
  return new DatabaseSync(file, {readOnly: true});
}

function openWritable(file) {
  const {DatabaseSync} = require('node:sqlite');
  return new DatabaseSync(file);
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function listTables(db) {
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
  } catch {
    return [];
  }
}

// A normal pass counts rows only; the deep pass adds the byte sums, which read
// every page and can take seconds on a multi-hundred-megabyte database.
function stats(file, {deep = false} = {}) {
  const availability = driver();
  if (!availability.ok) return {...availability, file, sizeBytes: fileSize(file), tables: [], totals: {rows: 0, bytes: null}};
  if (!fs.existsSync(file)) return {ok: true, driver: availability.driver, file, sizeBytes: 0, missing: true, tables: [], totals: {rows: 0, bytes: 0}};
  let db;
  try {
    db = openReadOnly(file);
    const known = new Map(TABLES.map((table) => [table.name, table]));
    const present = listTables(db);
    const tables = [];
    let totalRows = 0;
    let totalBytes = 0;
    for (const name of present) {
      const meta = known.get(name) || {name, category: '其他', label: name};
      let rows = null;
      let bytes = null;
      try { rows = db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count; } catch { /* schema drift */ }
      if (deep && meta.content && rows) {
        try { bytes = db.prepare(`SELECT SUM(${meta.content}) AS size FROM "${name}"`).get().size; } catch { /* not this release */ }
      }
      totalRows += rows || 0;
      totalBytes += bytes || 0;
      tables.push({name, category: meta.category, label: meta.label, rows, bytes});
    }
    tables.sort((a, b) => (b.bytes || 0) - (a.bytes || 0) || String(a.category).localeCompare(String(b.category)));
    return {
      ok: true,
      driver: availability.driver,
      file,
      sizeBytes: fileSize(file),
      deep,
      tables,
      totals: {rows: totalRows, bytes: deep ? totalBytes : null}
    };
  } catch (error) {
    return {ok: false, driver: availability.driver, file, sizeBytes: fileSize(file), error: String(error.message || error), tables: [], totals: {rows: 0, bytes: null}};
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

function pruneTraces(file, {days}) {
  if (!(days > 0)) return {removed: 0, skipped: 'retention disabled'};
  if (!fs.existsSync(file)) return {removed: 0, skipped: 'database missing'};
  const availability = driver();
  if (!availability.ok) throw new Error(availability.detail);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let db;
  try {
    db = openWritable(file);
    const result = db.prepare('DELETE FROM cursor_run_traces WHERE received_at_ms < ?').run(cutoff);
    return {
      removed: Number(result.changes) || 0,
      cutoff: new Date(cutoff).toISOString(),
      sizeAfter: fileSize(file)
    };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

function vacuum(file) {
  if (!fs.existsSync(file)) return {ok: false, error: 'database missing'};
  const availability = driver();
  if (!availability.ok) throw new Error(availability.detail);
  const before = fileSize(file);
  let db;
  try {
    db = openWritable(file);
    db.exec('VACUUM');
    return {ok: true, before, after: fileSize(file), saved: Math.max(0, before - fileSize(file))};
  } catch (error) {
    return {ok: false, error: String(error.message || error), before, after: fileSize(file)};
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

function backup(file, backupsDir) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(backupsDir, {recursive: true, mode: 0o700});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupsDir, `bridge-${stamp}.db`);
  fs.copyFileSync(file, target);
  fs.chmodSync(target, 0o600);
  try {
    const files = fs.readdirSync(backupsDir).filter((name) => /^bridge-.*\.db$/.test(name)).sort().reverse();
    for (const stale of files.slice(3)) {
      try { fs.unlinkSync(path.join(backupsDir, stale)); } catch { /* keep going */ }
    }
  } catch { /* no directory */ }
  return target;
}

module.exports = {TABLES, driver, stats, pruneTraces, vacuum, backup, fileSize};