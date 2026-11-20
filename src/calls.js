'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The shim sees every upstream call, so call history does not need the
// engine's SQLite schema. One JSONL file per day keeps appends O(1), makes
// rotation trivial and lets the console page backwards without loading a
// multi-hundred-megabyte database.
const DAY = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function dayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

class CallStore {
  constructor(dir, {retentionDays = 30} = {}) {
    this.dir = dir;
    this.retentionDays = retentionDays;
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    // The console polls status every two seconds. Re-reading the whole day's
    // JSONL on each poll would turn a cheap status call into disk I/O, so the
    // counters live in memory and are seeded once from today's file.
    this.today = dayKey();
    this.todayStats = {calls: 0, errors: 0, tokens: 0, duration: 0};
    this.seedToday();
  }

  seedToday() {
    try {
      const lines = fs.readFileSync(path.join(this.dir, `${this.today}.jsonl`), 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try { this.addToStats(JSON.parse(line)); } catch { /* skip */ }
      }
    } catch { /* no calls today */ }
  }

  addToStats(row) {
    this.todayStats.calls += 1;
    if (row.error || row.status >= 400) this.todayStats.errors += 1;
    this.todayStats.tokens += row.totalTokens || 0;
    this.todayStats.duration += row.durationMs || 0;
  }

  files() {
    try {
      return fs.readdirSync(this.dir).filter((name) => DAY.test(name)).sort().reverse();
    } catch {
      return [];
    }
  }

  record(entry) {
    const record = {
      ts: Number(entry.ts) || Date.now(),
      providerId: String(entry.providerId || '').slice(0, 40),
      providerName: String(entry.providerName || '').slice(0, 64),
      model: String(entry.model || '').slice(0, 200),
      upstreamModel: String(entry.upstreamModel || '').slice(0, 200),
      status: Number(entry.status) || 0,
      durationMs: Number(entry.durationMs) || 0,
      ttfbMs: entry.ttfbMs == null ? null : Number(entry.ttfbMs) || 0,
      inputTokens: Number(entry.inputTokens) || 0,
      outputTokens: Number(entry.outputTokens) || 0,
      totalTokens: Number(entry.totalTokens) || 0,
      error: entry.error ? String(entry.error).slice(0, 500) : null
    };
    try {
      const day = dayKey(record.ts);
      fs.appendFileSync(path.join(this.dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, {mode: 0o600});
      if (day !== this.today) {
        this.today = day;
        this.todayStats = {calls: 0, errors: 0, tokens: 0, duration: 0};
      }
      this.addToStats(record);
    } catch { /* a full disk must not take the proxy down */ }
    return record;
  }

  list({limit = 100, offset = 0} = {}) {
    const want = Math.max(1, Math.min(1000, Number(limit) || 100));
    const skip = Math.max(0, Number(offset) || 0);
    const rows = [];
    for (const name of this.files()) {
      let lines;
      try { lines = fs.readFileSync(path.join(this.dir, name), 'utf8').split(/\r?\n/).filter(Boolean); } catch { continue; }
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (skip > 0) { skip -= 1; continue; }
        try { rows.push(JSON.parse(lines[index])); } catch { /* skip a torn tail line */ }
        if (rows.length >= want) return rows;
      }
    }
    return rows;
  }

  summary() {
    // A long-running service can cross midnight while idle: move the window
    // forward and seed the new day once instead of reporting yesterday.
    const today = dayKey();
    if (today !== this.today) {
      this.today = today;
      this.todayStats = {calls: 0, errors: 0, tokens: 0, duration: 0};
      this.seedToday();
    }
    const {calls, errors, tokens, duration} = this.todayStats;
    return {
      day: today,
      calls,
      errors,
      tokens,
      averageMs: calls ? Math.round(duration / calls) : 0
    };
  }

  prune({days = this.retentionDays} = {}) {
    if (!(days > 0)) return {removed: 0};
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of this.files()) {
      const stamp = name.slice(0, 10);
      const at = new Date(`${stamp}T00:00:00`).getTime();
      if (Number.isFinite(at) && at < cutoff) {
        try { fs.unlinkSync(path.join(this.dir, name)); removed += 1; } catch { /* keep going */ }
      }
    }
    return {removed};
  }
}

module.exports = {CallStore, dayKey};