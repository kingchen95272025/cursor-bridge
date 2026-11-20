'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');

// A minimal cc-switch database: the two tables the importer reads, populated
// with a current provider, one token-less provider, a duplicate desktop entry
// that must be deduped, and a codex-only row that must be ignored.
function tempHomeWithCcSwitch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-ccswitch-'));
  const dir = path.join(home, '.cc-switch');
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'cc-switch.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE providers (
      id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
      settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
      created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
      meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0,
      in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
      cost_multiplier TEXT NOT NULL DEFAULT '1.0',
      limit_daily_usd TEXT, limit_monthly_usd TEXT, provider_type TEXT,
      PRIMARY KEY (id, app_type)
    );
    CREATE TABLE provider_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id TEXT NOT NULL,
      app_type TEXT NOT NULL, url TEXT NOT NULL, added_at INTEGER
    );
  `);
  const insert = db.prepare(`INSERT INTO providers
    (id, app_type, name, settings_config, website_url, is_current, sort_index)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insert.run('p1', 'claude', 'DeepSeek',
    JSON.stringify({env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-test-token',
      ANTHROPIC_MODEL: 'deepseek-chat',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-chat'
    }}),
    'https://deepseek.com', 1, 0);
  insert.run('p2', 'claude', 'NoToken',
    JSON.stringify({env: {ANTHROPIC_BASE_URL: 'https://zero.cat'}}), null, 0, 1);
  insert.run('p3', 'claude-desktop', 'DeepSeek',
    JSON.stringify({env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-desktop'
    }}), null, 0, 2);
  insert.run('c1', 'codex', 'Codex Only',
    JSON.stringify({env: {ANTHROPIC_BASE_URL: 'https://codex.example'}}), null, 0, 3);
  db.prepare('INSERT INTO provider_endpoints (provider_id, app_type, url) VALUES (?, ?, ?)')
    .run('p1', 'codex', 'https://api.deepseek.com/openai/v1');
  db.close();
  return home;
}

module.exports = {tempHomeWithCcSwitch};