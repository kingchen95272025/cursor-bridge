'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const configStore = require('./src/config.js');
const providers = require('./src/providers.js');
const {createPaths} = require('./src/paths.js');
const {ensureService, ServiceClient, readServiceInfo} = require('./src/service-client.js');
const {restoreProxy} = require('./lib/settings.js');
const platform = require('./lib/platform.js');
const {ConsolePanel} = require('./src/webview.js');

// The extension is deliberately thin. All long-lived work lives in the
// detached service; this file wires commands, the status bar and the webview
// to that service and keeps Cursor's settings in sync with the VS Code
// configuration object.

const SECRET_PREFIX = 'cursorBridge.key.';
const STATUS_POLL_MS = 2000;

let context = null;
let output = null;
let client = null;
let statusBar = null;
let pollTimer = null;
let lastSnapshot = null;
let connecting = null;
let rootPath = null;

function log(line) {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${line}`);
}

function paths() {
  return createPaths(rootPath);
}

function secretKey(providerId) {
  return `${SECRET_PREFIX}${providerId}`;
}

function runtimeFromSettings() {
  const settings = vscode.workspace.getConfiguration('cursorBridge');
  return {
    proxyPort: settings.get('proxyPort', 58160),
    runMode: settings.get('runMode', 'default'),
    refreshSeconds: settings.get('refreshSeconds', 15),
    logLimitMB: settings.get('logLimitMB', 4),
    tracesRetentionDays: settings.get('tracesRetentionDays', 0)
  };
}

function autoStartEnabled() {
  return vscode.workspace.getConfiguration('cursorBridge').get('autoStart', true);
}

function localConfig() {
  return configStore.read(rootPath);
}

// ---- service hand-off ----------------------------------------------------

async function connect() {
  if (client) {
    try { await client.status(); return client; } catch { client = null; }
  }
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      client = await ensureService({
        root: rootPath,
        log,
        noAutostart: !autoStartEnabled()
      });
      log(`service ready on port ${client.port} (v${client.version})`);
      await pushConfig(localConfig(), {silent: true});
      return client;
    } catch (error) {
      log(`service connection failed: ${error.message}`);
      client = null;
      throw error;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

async function collectSecrets(config) {
  const secrets = {};
  for (const provider of config.providers) {
    const value = await context.secrets.get(secretKey(provider.id));
    if (value) secrets[provider.id] = value;
  }
  return secrets;
}

async function pushConfig(config, {silent = false} = {}) {
  const service = await connect();
  const full = configStore.normalize({...config, runtime: runtimeFromSettings()});
  const secrets = await collectSecrets(full);
  const result = await service.config({config: full, secrets});
  if (!silent) log(`configuration pushed (${full.providers.length} providers)`);
  return result;
}

// ---- commands ------------------------------------------------------------

async function openConsole(focus = true) {
  ConsolePanel.show(context, {
    version: require('./package.json').version,
    onMessage: handleWebviewMessage,
    focus
  });
  if (lastSnapshot) ConsolePanel.post({type: 'state', state: lastSnapshot});
}

async function startBridge({force = false} = {}) {
  const service = await connect();
  const result = await service.start({force});
  if (result.status?.state === 'cert-missing') {
    vscode.window.showWarningMessage('Cursor Bridge：本地证书尚未受信任，请先在控制台完成证书初始化与信任。', '打开控制台')
      .then((choice) => { if (choice) openConsole(); });
    return result;
  }
  if (result.status?.state === 'needs-restart') {
    promptRestart();
  }
  return result;
}

async function stopBridge() {
  try {
    const service = await connect();
    await service.stop({restore: true});
    client = null;
    vscode.window.showInformationMessage('Cursor Bridge 已停止，代理设置已还原。请重启 Cursor 使网络设置完全恢复。');
  } catch (error) {
    // Even when the service is unreachable, the user asked for the proxy to
    // go away: restore it directly from the journal.
    try {
      restoreProxy(paths().journal);
      vscode.window.showInformationMessage('已直接还原代理设置。请重启 Cursor。');
    } catch (restoreError) {
      vscode.window.showErrorMessage(`还原代理失败：${restoreError.message}`);
    }
  }
}

function promptRestart() {
  vscode.window.showInformationMessage(
    'Cursor Bridge 已写入代理设置。需要完全退出并重新打开 Cursor 才会生效（仅重载窗口通常不够）。',
    '立即重载窗口'
  ).then((choice) => {
    if (choice) vscode.commands.executeCommand('workbench.action.reloadWindow');
  });
}

async function restoreProxyOnly() {
  try {
    const skipped = restoreProxy(paths().journal);
    if (skipped?.length) {
      vscode.window.showWarningMessage(`代理已还原；以下设置被其他程序改动，已保留：${skipped.join('、')}`);
    } else {
      vscode.window.showInformationMessage('代理设置已还原。请重启 Cursor。');
    }
  } catch (error) {
    vscode.window.showErrorMessage(`还原代理失败：${error.message}`);
  }
}

// ---- webview message handling -------------------------------------------

async function handleWebviewMessage(message) {
  try {
    const handler = handlers[message.action];
    if (!handler) throw new Error(`未知操作 ${message.action}`);
    const data = await handler(message.payload || {});
    ConsolePanel.post({type: 'result', id: message.id, ok: true, data});
    if (message.action !== 'status') await refreshStatus();
    return data;
  } catch (error) {
    log(`webview action ${message.action} failed: ${error.message}`);
    ConsolePanel.post({type: 'result', id: message.id, ok: false, error: String(error.message || error)});
    throw error;
  }
}

const handlers = {
  async status() {
    const service = await connect();
    return service.status();
  },

  async refresh() {
    const service = await connect();
    return service.status();
  },

  async 'import-magpie'() {
    const connection = providers.readMagpieConnection(require('node:os').homedir());
    if (!connection) throw new Error('未发现 Magpie 连接：请在 Magpie → Agents 连接 Cursor Bridge 后重试');
    const config = localConfig();
    const existing = config.providers.find((provider) => provider.type === 'magpie' && provider.autoDiscover);
    const provider = existing || {
      id: uniqueProviderId('magpie', config),
      type: 'magpie',
      name: 'Magpie',
      enabled: true,
      autoDiscover: true,
      baseUrl: connection.gateway,
      headers: {},
      models: []
    };
    provider.baseUrl = connection.gateway;
    provider.enabled = true;
    const next = {...config, providers: existing
      ? config.providers.map((entry) => (entry.id === provider.id ? provider : entry))
      : [...config.providers, provider]};
    await pushConfig(next);
    return {provider, detected: connection.models.length};
  },

  async 'save-provider'({provider: raw, key, clearKey}) {
    const normalized = configStore.normalizeProvider(raw);
    if (!normalized) throw new Error('Provider 配置无效：ID 只能包含小写字母、数字、- 和 _，Base URL 必须是 http(s) 地址');
    const config = localConfig();
    const index = config.providers.findIndex((entry) => entry.id === normalized.id);
    if (index >= 0) config.providers[index] = normalized;
    else config.providers.push(normalized);
    if (clearKey) await context.secrets.delete(secretKey(normalized.id));
    else if (typeof key === 'string' && key.trim()) await context.secrets.store(secretKey(normalized.id), key.trim());
    await pushConfig(config);
    return {provider: normalized};
  },

  async 'delete-provider'({id}) {
    const config = localConfig();
    const next = {...config, providers: config.providers.filter((provider) => provider.id !== id)};
    await context.secrets.delete(secretKey(id));
    await pushConfig(next);
    return {removed: id};
  },

  async 'toggle-provider'({id, enabled}) {
    const config = localConfig();
    const next = {...config, providers: config.providers.map((provider) => (
      provider.id === id ? {...provider, enabled: enabled !== false} : provider
    ))};
    await pushConfig(next);
    return {id, enabled};
  },

  async 'test-provider'({provider: raw, key}) {
    const normalized = configStore.normalizeProvider(raw);
    if (!normalized) throw new Error('Provider 配置无效');
    const savedKey = key || await context.secrets.get(secretKey(normalized.id)) || '';
    const models = await providers.fetchModels({
      ...normalized,
      key: normalized.type === 'magpie' && normalized.autoDiscover
        ? (providers.readMagpieConnection(require('node:os').homedir())?.key || savedKey)
        : savedKey
    });
    return {count: models.length, models: models.slice(0, 20), sample: models.slice(0, 3).map((model) => model.id)};
  },

  async 'set-model-prefs'({providerId, prefs}) {
    const config = localConfig();
    const next = {
      ...config,
      modelPrefs: {...config.modelPrefs, [providerId]: {
        names: prefs?.names || {},
        hidden: prefs?.hidden || [],
        order: prefs?.order || []
      }}
    };
    await pushConfig(next);
    return {providerId};
  },

  async 'select-model'({id}) {
    const config = localConfig();
    await pushConfig({...config, selectedModel: id || null});
    return {selectedModel: id};
  },

  async start() {
    const service = await connect();
    const result = await service.start({force: false});
    if (result.status?.state === 'needs-restart') promptRestart();
    return result;
  },

  async 'force-start'() {
    const service = await connect();
    const result = await service.start({force: true});
    if (result.status?.state === 'needs-restart') promptRestart();
    return result;
  },

  async stop() {
    const service = await connect();
    const result = await service.stop({restore: true});
    return result;
  },

  async restart() {
    const service = await connect();
    return service.restart({force: true});
  },

  async 'init-cert'() {
    const service = await connect();
    return service.certInit();
  },

  async 'trust-cert'() {
    const service = await connect();
    const result = await service.certTrust();
    if (result.status?.state === 'needs-restart') promptRestart();
    return result;
  },

  async diagnose() {
    const service = await connect();
    return service.diagnose();
  },

  async calls({limit = 100, offset = 0}) {
    const service = await connect();
    return service.calls({limit, offset});
  },

  async 'db-stats'({deep = false}) {
    const service = await connect();
    return service.dbStats({deep});
  },

  async 'db-prune'({days}) {
    const service = await connect();
    return service.dbPrune({days});
  },

  async 'db-vacuum'() {
    const service = await connect();
    return service.dbVacuum();
  },

  async logs({source = 'engine', lines = 200}) {
    const service = await connect();
    return service.logs({source, lines});
  },

  async 'open-rescue'() {
    const dir = path.join(require('node:os').homedir(), '.cursor-bridge');
    if (!fs.existsSync(dir)) throw new Error('救援脚本尚未生成（首次写入代理后才会创建）');
    await vscode.env.openExternal(vscode.Uri.file(dir));
    return {dir};
  },

  async 'reload-window'() {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return {};
  },

  async 'open-external'({url}) {
    if (!/^https?:\/\//.test(String(url || ''))) throw new Error('仅支持 http(s) 链接');
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return {};
  }
};

function uniqueProviderId(base, config) {
  const used = new Set(config.providers.map((provider) => provider.id));
  if (!used.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}${Date.now().toString(36)}`;
}

// ---- status bar ----------------------------------------------------------

function statusAppearance(snapshot) {
  const state = snapshot?.state || 'offline';
  switch (state) {
    case 'connected':
      return {icon: '$(radio-tower)', text: 'Cursor Bridge', tooltip: `已连接 · ${snapshot.catalogue?.count || 0} 个模型 · ${snapshot.engine?.proxy || ''}`, color: undefined};
    case 'needs-restart':
      return {icon: '$(warning)', text: 'Cursor Bridge · 待重启', tooltip: '代理已写入，重启 Cursor 后生效', color: new vscode.ThemeColor('statusBarItem.warningBackground')};
    case 'starting':
      return {icon: '$(sync~spin)', text: 'Cursor Bridge · 启动中', tooltip: snapshot?.detail || '正在启动桥接', color: undefined};
    case 'cert-missing':
      return {icon: '$(shield)', text: 'Cursor Bridge · 证书待信任', tooltip: snapshot?.detail || '请在控制台信任本地 CA', color: new vscode.ThemeColor('statusBarItem.warningBackground')};
    case 'conflict':
      return {icon: '$(alert)', text: 'Cursor Bridge · 冲突', tooltip: snapshot?.detail || '检测到旧版桥接仍在运行', color: new vscode.ThemeColor('statusBarItem.errorBackground')};
    case 'error':
      return {icon: '$(error)', text: 'Cursor Bridge · 错误', tooltip: snapshot?.detail || '桥接启动失败', color: new vscode.ThemeColor('statusBarItem.errorBackground')};
    case 'paused':
      return {icon: '$(debug-pause)', text: 'Cursor Bridge · 已暂停', tooltip: snapshot?.detail || '代理设置被外部改动', color: new vscode.ThemeColor('statusBarItem.warningBackground')};
    case 'stopped':
      return {icon: '$(debug-disconnect)', text: 'Cursor Bridge · 已停止', tooltip: '点击打开控制台', color: undefined};
    case 'unconfigured':
      return {icon: '$(beaker)', text: 'Cursor Bridge · 未配置', tooltip: '点击配置上游提供者', color: undefined};
    default:
      return {icon: '$(debug-disconnect)', text: 'Cursor Bridge · 离线', tooltip: '后台服务未运行', color: undefined};
  }
}

function renderStatus(snapshot) {
  if (!statusBar) return;
  const appearance = statusAppearance(snapshot);
  statusBar.text = `${appearance.icon} ${appearance.text}`;
  statusBar.tooltip = appearance.tooltip;
  statusBar.backgroundColor = appearance.color;
  statusBar.show();
}

async function refreshStatus() {
  let snapshot = null;
  try {
    const service = await connect();
    snapshot = await service.status();
  } catch (error) {
    snapshot = {state: 'offline', detail: String(error.message || error), catalogue: {count: 0}, providers: [], config: localConfig()};
  }
  lastSnapshot = snapshot;
  renderStatus(snapshot);
  ConsolePanel.post({type: 'state', state: snapshot});
  return snapshot;
}

// ---- activation ----------------------------------------------------------

async function activate(ctx) {
  context = ctx;
  rootPath = ctx.globalStorageUri.fsPath;
  fs.mkdirSync(rootPath, {recursive: true, mode: 0o700});
  output = vscode.window.createOutputChannel('Cursor Bridge');
  ctx.subscriptions.push(output);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'cursorBridge.openConsole';
  ctx.subscriptions.push(statusBar);
  renderStatus(null);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('cursorBridge.openConsole', () => openConsole()),
    vscode.commands.registerCommand('cursorBridge.start', () => startBridge()),
    vscode.commands.registerCommand('cursorBridge.stop', () => stopBridge()),
    vscode.commands.registerCommand('cursorBridge.restart', async () => {
      const service = await connect();
      await service.restart({force: true});
      vscode.window.showInformationMessage('Cursor Bridge 已重启。');
    }),
    vscode.commands.registerCommand('cursorBridge.restoreProxy', () => restoreProxyOnly())
  );

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('cursorBridge')) return;
    pushConfig(localConfig(), {silent: true}).catch((error) => log(`settings push failed: ${error.message}`));
  }));

  const auto = autoStartEnabled();
  connect()
    .then(() => refreshStatus())
    .then(async (snapshot) => {
      const config = localConfig();
      if (!config.providers.length) {
        // Only the very first activation opens the console by itself. After
        // that, an empty configuration is a normal state and the status bar is
        // enough of a reminder; stealing focus on every launch is not.
        if (!config.onboardingDone) {
          openConsole(false);
          pushConfig({...config, onboardingDone: true}, {silent: true}).catch(() => {});
        }
        return;
      }
      if (auto && ['unconfigured', 'stopped'].includes(snapshot?.state)) {
        log('autoStart: starting bridge');
        try { await startBridge(); } catch (error) { log(`autoStart failed: ${error.message}`); }
      }
    })
    .catch((error) => {
      log(`activation failed: ${error.message}`);
      vscode.window.showErrorMessage(`Cursor Bridge 服务启动失败：${error.message}`, '查看日志')
        .then((choice) => { if (choice) output.show(); });
    });

  pollTimer = setInterval(() => { refreshStatus().catch(() => {}); }, STATUS_POLL_MS);
  ctx.subscriptions.push({dispose: () => clearInterval(pollTimer)});
}

function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  // Deliberately no service shutdown: the user chose "keep the proxy after the
  // window closes". The service keeps the engine alive and the next window
  // reconnects in about a second.
}

module.exports = {activate, deactivate};