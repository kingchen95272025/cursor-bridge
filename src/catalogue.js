'use strict';

// Cursor asks the engine for one flat model list. Every provider contributes
// its models under "<providerId>/<upstreamModelId>". The provider id grammar is
// [a-z0-9][a-z0-9_-]{0,31}, so splitting on the *first* slash is unambiguous
// even when the upstream id itself contains slashes (anthropic/claude-...).
//
// The prefix is the whole routing contract between Cursor, the engine and the
// shim; nothing else about a model id is rewritten.

const SEPARATOR = '/';

function encode(providerId, upstreamId) {
  return `${providerId}${SEPARATOR}${upstreamId}`;
}

function decode(aggregatedId) {
  const text = String(aggregatedId || '');
  const index = text.indexOf(SEPARATOR);
  if (index <= 0 || index === text.length - 1) return null;
  const providerId = text.slice(0, index);
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(providerId)) return null;
  return {providerId, upstreamId: text.slice(index + 1)};
}

function applyPrefs(models, prefs = {}) {
  const names = prefs.names && typeof prefs.names === 'object' ? prefs.names : {};
  const hidden = new Set(Array.isArray(prefs.hidden) ? prefs.hidden : []);
  const order = Array.isArray(prefs.order) ? prefs.order : [];
  const rank = new Map(order.map((id, index) => [id, index]));
  return models
    .filter((model) => !hidden.has(model.upstreamId))
    .map((model) => ({
      ...model,
      name: String(names[model.upstreamId] || model.name || model.upstreamId).trim() || model.upstreamId
    }))
    .sort((a, b) => {
      const ra = rank.has(a.upstreamId) ? rank.get(a.upstreamId) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.upstreamId) ? rank.get(b.upstreamId) : Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
}

// `refreshed` is the provider result list from providers.refreshProvider().
function build(refreshed, modelPrefs = {}) {
  const groups = [];
  for (const entry of refreshed) {
    if (!entry || entry.error && !entry.models?.length) continue;
    const provider = entry.provider;
    const models = (entry.models || []).map((model) => ({
      id: encode(provider.id, model.id),
      upstreamId: model.id,
      providerId: provider.id,
      providerName: provider.name,
      name: model.name || model.id,
      context: model.context || null
    }));
    groups.push({
      providerId: provider.id,
      providerName: provider.name,
      models: applyPrefs(models, modelPrefs[provider.id]),
      error: entry.error || null
    });
  }

  // Two providers can expose the same display name. Cursor renders names, not
  // ids, so disambiguate only when the collision actually happens.
  const nameCounts = new Map();
  for (const group of groups) {
    for (const model of group.models) nameCounts.set(model.name, (nameCounts.get(model.name) || 0) + 1);
  }
  const flat = [];
  for (const group of groups) {
    for (const model of group.models) {
      flat.push({
        id: model.id,
        name: nameCounts.get(model.name) > 1 ? `${model.name} · ${model.providerName}` : model.name,
        context: model.context,
        providerId: model.providerId,
        upstreamId: model.upstreamId,
        providerName: model.providerName
      });
    }
  }
  return {models: flat, groups};
}

function pickDefault(catalogue, selectedModel) {
  const ids = new Set(catalogue.map((model) => model.id));
  if (selectedModel && ids.has(selectedModel)) return selectedModel;
  return catalogue.length ? catalogue[0].id : null;
}

module.exports = {
  SEPARATOR,
  encode,
  decode,
  build,
  pickDefault,
  applyPrefs
};