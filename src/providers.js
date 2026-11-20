'use strict';
const fs = require('node:fs');
const platform = require('../lib/platform.js');

// A provider is anything that speaks the OpenAI wire format. Magpie is the
// built-in one: its agent page writes connection.json, and the VSIX reads that
// file live on every refresh, so switching models in Magpie reaches Cursor
// without reconnecting anything. Custom providers are plain base URL + key.
//
// `resolve()` returns only runtime facts; nothing here touches the network
// except fetchModels().

const MODEL_TIMEOUT_MS = 8000;

function readMagpieConnection(home) {
  for (const file of platform.connectionFilesFor(home)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || parsed.enabled !== true) return null;
      const gateway = String(parsed.gateway || '').trim().replace(/\/+$/, '');
      const key = String(parsed.key || '').trim();
      if (!gateway || !key) return null;
      const models = Array.isArray(parsed.models) ? parsed.models : [];
      return {
        gateway,
        key,
        model: typeof parsed.model === 'string' ? parsed.model : null,
        models: models
          .filter((m) => m && typeof m.id === 'string' && m.id.trim())
          .map((m) => ({
            id: m.id.trim(),
            name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : m.id.trim(),
            context: Number.isFinite(m.context) ? m.context : null
          })),
        file
      };
    } catch { /* try the next candidate */ }
  }
  return null;
}

// Magpie validates its gateway as loopback; a custom provider may be remote.
// Both end up as the same runtime record so the shim has one route table.
function resolve(configProviders, secrets, home) {
  const resolved = [];
  const problems = [];
  for (const provider of configProviders) {
    if (!provider.enabled) continue;
    if (provider.type === 'magpie' && provider.autoDiscover) {
      const connection = readMagpieConnection(home);
      if (!connection) {
        problems.push({providerId: provider.id, message: '未发现 Magpie 连接：请在 Magpie → Agents 连接 Cursor Bridge，或在控制台关闭自动发现并手动填写网关。'});
        continue;
      }
      resolved.push({
        id: provider.id,
        name: provider.name,
        type: 'magpie',
        baseUrl: connection.gateway,
        key: connection.key,
        headers: provider.headers || {},
        knownModels: connection.models,
        preferredModel: connection.model,
        source: connection.file
      });
      continue;
    }
    resolved.push({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      key: secrets[provider.id] || '',
      headers: provider.headers || {},
      knownModels: provider.models.map((id) => ({id, name: id, context: null})),
      preferredModel: null,
      source: null
    });
  }
  return {providers: resolved, problems};
}

function normalizeModel(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return {id: raw.trim(), name: raw.trim(), context: null};
  const id = String(raw.id || raw.model || raw.name || '').trim();
  if (!id) return null;
  const name = String(raw.name || raw.display_name || id).trim();
  const context = Number(raw.context_window ?? raw.context_length ?? raw.context ?? raw.max_context_length);
  return {id, name: name || id, context: Number.isFinite(context) && context > 0 ? context : null};
}

function extractModels(body) {
  const list = Array.isArray(body?.data) ? body.data
    : Array.isArray(body?.models) ? body.models
      : Array.isArray(body) ? body : [];
  const models = [];
  const seen = new Set();
  for (const raw of list) {
    const model = normalizeModel(raw);
    if (model && !seen.has(model.id)) {
      seen.add(model.id);
      models.push(model);
    }
  }
  return models;
}

async function fetchModels(provider, {timeoutMs = MODEL_TIMEOUT_MS} = {}) {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`;
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'cursor-bridge/0.1',
    ...provider.headers
  };
  if (provider.key) headers.Authorization = `Bearer ${provider.key}`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error'
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${provider.name} 模型目录 HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const body = await response.json();
  const models = extractModels(body);
  if (!models.length) throw new Error(`${provider.name} 未返回任何模型`);
  return models;
}

// Provider model lists are merged by the catalogue; a provider that is down
// must not hide the models it advertised earlier in the same session, so the
// caller keeps the last good list and only surfaces the error.
async function refreshProvider(provider, previous = null) {
  try {
    const models = await fetchModels(provider);
    return {provider, models, error: null, refreshedAt: Date.now()};
  } catch (error) {
    return {
      provider,
      models: previous?.models?.length ? previous.models : provider.knownModels,
      error: String(error?.message || error),
      refreshedAt: Date.now()
    };
  }
}

module.exports = {
  readMagpieConnection,
  resolve,
  fetchModels,
  refreshProvider,
  normalizeModel,
  extractModels
};