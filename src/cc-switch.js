'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const platform = require('../lib/platform.js');

// cc-switch stores Claude Code providers, not Cursor providers. A provider
// there is an Anthropic base URL (ANTHROPIC_BASE_URL) plus a token. Many of
// those gateways also expose OpenAI-compatible routes, which is what the
// bridge needs.
//
// Two consumers share this module:
//   - the one-shot importer, which copies selected providers into ordinary
//     OpenAI-compatible entries;
//   - the live `cc-switch` provider type, which follows whichever provider is
//     marked current in cc-switch (like the Magpie provider follows its
//     connection.json).
//
// Recent cc-switch versions moved from config.json to SQLite; both layouts are
// supported. `scan()` strips tokens so the webview only sees names, URLs and a
// "has token" flag.

const APP_TYPES = ['claude', 'claude-desktop'];

function configDirFor(home) {
  if (platform.IS_WIN) {
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const candidate of [path.join(roaming, 'cc-switch'), path.join(home, '.cc-switch')]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(home, '.cc-switch');
  }
  return path.join(home, '.cc-switch');
}

function sqliteRows(file) {
  try {
    const {DatabaseSync} = require('node:sqlite');
    const db = new DatabaseSync(file, {readOnly: true});
    try {
      const rows = db.prepare(
        `SELECT id, app_type, name, settings_config, website_url, is_current
         FROM providers WHERE app_type IN ('claude','claude-desktop')
         ORDER BY app_type, sort_index`
      ).all();
      let endpoints = [];
      try {
        endpoints = db.prepare('SELECT provider_id, url FROM provider_endpoints').all();
      } catch { /* older schema */ }
      return {rows: rows.map((row) => ({...row})), endpoints: endpoints.map((row) => ({...row}))};
    } finally {
      db.close();
    }
  } catch (error) {
    const sqlite3 = platform.findExecutable(['/usr/bin/sqlite3', '/usr/local/bin/sqlite3', '/opt/homebrew/bin/sqlite3', 'sqlite3']);
    if (!sqlite3) throw new Error(`无法读取 cc-switch 数据库（${error.message}）`);
    const query = (sql) => JSON.parse(execFileSync(sqlite3, ['-json', file, sql], {
      encoding: 'utf8', timeout: 15000, windowsHide: true
    }) || '[]');
    const rows = query(
      `SELECT id, app_type, name, settings_config, website_url, is_current
       FROM providers WHERE app_type IN ('claude','claude-desktop')
       ORDER BY app_type, sort_index`
    );
    let endpoints = [];
    try { endpoints = query('SELECT provider_id, url FROM provider_endpoints'); } catch { /* older schema */ }
    return {rows, endpoints};
  }
}

function envOf(settingsConfig) {
  let parsed = settingsConfig;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return {}; }
  }
  return parsed && typeof parsed === 'object' && parsed.env && typeof parsed.env === 'object'
    ? parsed.env
    : {};
}

const MODEL_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL'
];

function modelsFromEnv(env) {
  const models = [];
  for (const key of MODEL_KEYS) {
    const value = String(env[key] || '').trim();
    if (value && !models.includes(value)) models.push(value);
  }
  return models.slice(0, 20);
}

function tokenFromEnv(env) {
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    const value = String(env[key] || '').trim();
    if (value) return {token: value, source: key};
  }
  return {token: '', source: null};
}

// Anthropic-only gateways are common (/anthropic, /claude paths, no /v1).
// Ordering matters: the provider's own gateway root is the most likely place
// for an OpenAI route, an Anthropic-specific path is the least likely, and
// extra endpoints are a fallback because cc-switch can attach an endpoint that
// belongs to another provider in the same account.
function baseCandidates(baseUrl, endpoints = []) {
  const urls = [];
  const add = (value) => {
    const url = String(value || '').trim().replace(/\/+$/, '');
    if (url && /^https?:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
  };
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return urls;
  const stripped = base.replace(/\/(anthropic|claude|claude-code|messages)$/i, '');
  const roots = stripped !== base ? [stripped] : [base];
  for (const root of roots) {
    add(root);
    // /v1 belongs on the gateway root, never on an Anthropic-specific path:
    // .../anthropic/v1 is not a route any gateway serves.
    if (!/\/v\d+(\/|$)/.test(root)) add(`${root}/v1`);
  }
  if (stripped !== base) add(base);
  for (const endpoint of endpoints) add(endpoint);
  return urls.slice(0, 4);
}

function normalizeEntry(row, endpointMap, env) {
  const values = env || envOf(row.settings_config);
  const baseUrl = String(values.ANTHROPIC_BASE_URL || '').trim();
  if (!baseUrl) return null;
  const {token, source} = tokenFromEnv(values);
  const endpoints = endpointMap.get(row.id) || [];
  return {
    key: `${row.id}\u0000${row.app_type}`,
    id: row.id,
    appType: row.app_type,
    name: String(row.name || row.id),
    baseUrl,
    websiteUrl: row.website_url || null,
    hasToken: !!token,
    tokenSource: source,
    token,
    models: modelsFromEnv(values),
    isCurrent: row.is_current === 1 || row.is_current === true,
    endpoints,
    candidates: baseCandidates(baseUrl, endpoints)
  };
}

function dedupe(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const signature = `${entry.name}\u0000${entry.baseUrl}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(entry);
  }
  return result;
}

function fromSqlite(file) {
  const {rows, endpoints} = sqliteRows(file);
  const endpointMap = new Map();
  for (const endpoint of endpoints) {
    if (!endpoint.provider_id || !endpoint.url) continue;
    const list = endpointMap.get(endpoint.provider_id) || [];
    list.push(endpoint.url);
    endpointMap.set(endpoint.provider_id, list);
  }
  return dedupe(rows.map((row) => normalizeEntry(row, endpointMap)).filter(Boolean));
}

function fromJson(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = [];
  for (const appType of APP_TYPES) {
    const app = raw?.[appType];
    if (!app || typeof app !== 'object') continue;
    // v1 kept an object keyed by id; v2 uses an array. Accept both.
    const providers = Array.isArray(app.providers)
      ? app.providers
      : app.providers && typeof app.providers === 'object'
        ? Object.values(app.providers)
        : [];
    for (const provider of providers) {
      if (!provider || typeof provider !== 'object') continue;
      const id = String(provider.id || provider.name || '').trim();
      if (!id) continue;
      const settings = provider.settingsConfig || provider.settings_config || {};
      const entry = normalizeEntry({
        id,
        app_type: appType,
        name: provider.name || id,
        website_url: provider.websiteUrl || provider.website_url || null,
        is_current: (app.current || app.currentProvider) === id
      }, new Map(), envOf(settings));
      if (entry) entries.push(entry);
    }
  }
  return dedupe(entries);
}

function locate(home = os.homedir()) {
  const dir = configDirFor(home);
  const db = path.join(dir, 'cc-switch.db');
  if (fs.existsSync(db)) return {kind: 'sqlite', file: db};
  for (const name of ['config.json', 'config.json.migrated', 'config.json.bak']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return {kind: 'json', file};
  }
  return null;
}

// Reads all entries with tokens. Callers decide what may leave the process.
function readEntries(home) {
  const located = locate(home);
  if (!located) return {located: null, entries: []};
  return {
    located,
    entries: located.kind === 'sqlite' ? fromSqlite(located.file) : fromJson(located.file)
  };
}

function stripToken(entry) {
  const {token, ...rest} = entry;
  return rest;
}

function scan(home = os.homedir()) {
  try {
    const {located, entries} = readEntries(home);
    if (!located) {
      return {source: null, file: null, providers: [], error: '未找到 cc-switch 配置（~/.cc-switch）'};
    }
    return {
      source: located.kind === 'sqlite' ? 'cc-switch.db' : path.basename(located.file),
      file: located.file,
      providers: entries.map(stripToken).sort((a, b) => (
        Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name, 'zh-CN')
      )),
      error: null
    };
  } catch (error) {
    return {source: null, file: null, providers: [], error: String(error.message || error)};
  }
}

// Extension-side only: the returned record carries the token.
function load(home, key) {
  const {located, entries} = readEntries(home);
  if (!located) throw new Error('未找到 cc-switch 配置（~/.cc-switch）');
  const entry = entries.find((candidate) => candidate.key === key);
  if (!entry) throw new Error('cc-switch 中找不到该供应商（可能已被删除）');
  return entry;
}

// The provider the user is currently using in cc-switch. `claude` wins over
// `claude-desktop` because Cursor corresponds to Claude Code. If cc-switch has
// no explicit current marker, the first entry with a token is used and flagged
// implicit so the console can say why.
function current(home = os.homedir()) {
  const {located, entries} = readEntries(home);
  if (!located) return null;
  const explicit = entries.find((entry) => entry.appType === 'claude' && entry.isCurrent)
    || entries.find((entry) => entry.isCurrent);
  if (explicit) return {...explicit, implicit: false};
  const fallback = entries.find((entry) => entry.appType === 'claude' && entry.hasToken)
    || entries.find((entry) => entry.hasToken);
  return fallback ? {...fallback, implicit: true} : null;
}

module.exports = {
  APP_TYPES,
  configDirFor,
  locate,
  scan,
  load,
  current,
  readEntries,
  baseCandidates,
  modelsFromEnv,
  tokenFromEnv,
  envOf
};