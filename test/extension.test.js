'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Loading extension.js outside Cursor needs a `vscode` module. The mock below
// is intentionally small: it proves the wiring (commands, status bar, webview,
// secret storage) without pretending to be the whole editor API.

function mockVscode(root) {
  const registered = [];
  const statusBar = {
    shown: false,
    text: '',
    tooltip: '',
    command: '',
    show() { this.shown = true; },
    hide() { this.shown = false; },
    dispose() {}
  };
  const webview = {
    cspSource: 'vscode-webview://test',
    html: '',
    asWebviewUri: (uri) => uri,
    postMessage: async () => true,
    onDidReceiveMessage: () => ({dispose() {}})
  };
  const panel = {webview, reveal() {}, onDidDispose: () => ({dispose() {}}), dispose() {}};
  return {
    registered,
    statusBar,
    window: {
      createOutputChannel: () => ({appendLine() {}, show() {}, dispose() {}}),
      createStatusBarItem: () => statusBar,
      createWebviewPanel: () => panel,
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined
    },
    commands: {
      registerCommand: (id, handler) => {
        registered.push({id, handler});
        return {dispose() {}};
      },
      executeCommand: async () => undefined
    },
    workspace: {
      getConfiguration: () => ({get: (key, fallback) => fallback}),
      onDidChangeConfiguration: () => ({dispose() {}})
    },
    StatusBarAlignment: {Right: 2},
    ViewColumn: {Active: -1},
    ThemeColor: class { constructor(value) { this.value = value; } },
    Uri: {
      file: (value) => ({fsPath: value, scheme: 'file'}),
      parse: (value) => ({toString: () => value}),
      joinPath: (base, ...parts) => ({fsPath: path.join(base.fsPath, ...parts), scheme: 'file', toString() { return `file://${this.fsPath}`; }})
    },
    env: {openExternal: async () => true}
  };
}

test('扩展入口可加载、可激活并注册全部命令', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-ext-'));
  const vscode = mockVscode(root);
  const fakeStatus = {state: 'unconfigured', catalogue: {count: 0}, providers: [], config: {providers: []}, service: {running: true, port: 1}};
  const fakeClient = {
    port: 1,
    version: '0.1.0',
    status: async () => fakeStatus,
    config: async ({config}) => ({ok: true, config, status: fakeStatus})
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    if (request === 'vscode') return vscode;
    if (request === './src/service-client.js' || request.endsWith('/src/service-client.js')) {
      return {
        ensureService: async () => fakeClient,
        ServiceClient: class {},
        readServiceInfo: () => null
      };
    }
    return originalLoad.apply(this, arguments);
  };
  t.after(() => { Module._load = originalLoad; });

  const entry = path.join(__dirname, '..', 'extension.js');
  delete require.cache[require.resolve(entry)];
  const extension = require(entry);

  const context = {
    globalStorageUri: {fsPath: root},
    subscriptions: [],
    extensionUri: {fsPath: path.join(__dirname, '..')},
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {}
    }
  };
  await extension.activate(context);
  await new Promise((resolve) => setTimeout(resolve, 60));

  const ids = vscode.registered.map((command) => command.id);
  for (const id of ['cursorBridge.openConsole', 'cursorBridge.start', 'cursorBridge.stop', 'cursorBridge.restart', 'cursorBridge.restoreProxy']) {
    assert.ok(ids.includes(id), `缺少命令 ${id}`);
  }
  assert.equal(vscode.statusBar.shown, true);
  assert.match(vscode.statusBar.text, /Cursor Bridge/);
  assert.ok(fs.existsSync(root));

  extension.deactivate();
});