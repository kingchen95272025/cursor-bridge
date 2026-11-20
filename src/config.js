'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {atomic} = require('../lib/settings.js');

// The console owns provider configuration; keys never enter this file. API
// keys live in Cursor's SecretStorage (extension side) and are pushed to the
// running service over loopback into memory only.
const DEFAULT_RUNTIME = {
  proxyPort: 58160,
  runMode: 'default',
  refreshSeconds: 15,
  logLimitMB: 4,
  tracesRetentionDays: 0
};

const DEFAULT_CONFIG = {
  version: 1,
  providers: [],
  modelPrefs: {},
  selectedModel: null,
  onboardingDone: false,
  runtime: {...DEFAULT_RUNTIME}
};

function normalizeRuntime(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const port = Number(value.proxyPort);
  const refresh = Number(value.refreshSeconds);
  const limit = Number(value.logLimitMB);
  const retention = Number(value.tracesRetentionDays);
  return {
    proxyPort: Number.isFinite(port) && port > 0 && port < 65536 ? Math.round(port) : DEFAULT_RUNTIME.proxyPort,
    runMode: value.runMode === 'lite' ? 'lite' : 'default',
    refreshSeconds: Number.isFinite(refresh) && refresh >= 5 ? Math.round(refresh) : DEFAULT_RUNTIME.refreshSeconds,
    logLimitMB: Number.isFinite(limit) && limit >= 1 ? Math.round(limit) : DEFAULT_RUNTIME.logLimitMB,
    tracesRetentionDays: Number.isFinite(retention) && retention > 0 ? Math.round(retention) : 0
  };
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function normalizeProvider(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().toLowerCase();
  if (!PROVIDER_ID.test(id)) return null;
  const type = raw.type === 'magpie' ? 'magpie' : 'openai';
  const name = String(raw.name || id).trim().slice(0, 64) || id;
  let baseUrl = String(raw.baseUrl || '').trim().replace(/\/+$/, '');
  if (type === 'magpie' && !baseUrl) baseUrl = 'http://127.0.0.1:3425/v1';
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
  } catch {
    return null;
  }
  const headers = {};
  if (raw.headers && typeof raw.headers === 'object') {
    for (const [key, value] of Object.entries(raw.headers)) {
      if (typeof key === 'string' && key && typeof value === 'string') headers[key] = value;
    }
  }
  const models = Array.isArray(raw.models)
    ? [...new Set(raw.models.map((m) => String(m || '').trim()).filter(Boolean))].slice(0, 500)
    : [];
  return {
    id,
    type,
    name,
    enabled: raw.enabled !== false,
    autoDiscover: type === 'magpie' && raw.autoDiscover !== false,
    baseUrl,
    headers,
    models
  };
}

function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const providers = [];
  const seen = new Set();
  for (const candidate of Array.isArray(source.providers) ? source.providers : []) {
    const provider = normalizeProvider(candidate);
    if (provider && !seen.has(provider.id)) {
      seen.add(provider.id);
      providers.push(provider);
    }
  }
  const prefs = {};
  if (source.modelPrefs && typeof source.modelPrefs === 'object') {
    for (const [providerId, value] of Object.entries(source.modelPrefs)) {
      if (!seen.has(providerId) || !value || typeof value !== 'object') continue;
      prefs[providerId] = {
        names: value.names && typeof value.names === 'object' ? {...value.names} : {},
        hidden: Array.isArray(value.hidden) ? value.hidden.map(String) : [],
        order: Array.isArray(value.order) ? value.order.map(String) : []
      };
    }
  }
  return {
    ...DEFAULT_CONFIG,
    providers,
    modelPrefs: prefs,
    selectedModel: typeof source.selectedModel === 'string' ? source.selectedModel : null,
    onboardingDone: source.onboardingDone === true,
    runtime: normalizeRuntime(source.runtime)
  };
}

function read(root) {
  const file = path.join(root, 'config.json');
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return normalize(null);
  }
}

function write(root, config) {
  const file = path.join(root, 'config.json');
  const normalized = normalize(config);
  atomic(file, JSON.stringify(normalized, null, 2));
  return normalized;
}

module.exports = {DEFAULT_CONFIG, DEFAULT_RUNTIME, PROVIDER_ID, normalize, normalizeProvider, normalizeRuntime, read, write};