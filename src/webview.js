'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const crypto = require('node:crypto');

// One console panel per window. The HTML lives in media/ so the markup, styles
// and script can be reviewed independently; this class only owns the webview
// lifecycle, the CSP nonce and message plumbing.
class ConsolePanel {
  static current = null;

  static show(context, {version, onMessage, focus = true}) {
    if (ConsolePanel.current) {
      ConsolePanel.current.panel.reveal(vscode.ViewColumn.Active);
      return ConsolePanel.current;
    }
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'cursorBridgeConsole',
      'Cursor Bridge',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        preserveFocus: !focus,
        localResourceRoots: [mediaRoot]
      }
    );
    const instance = new ConsolePanel({panel, context, mediaRoot, version, onMessage});
    ConsolePanel.current = instance;
    return instance;
  }

  static post(message) {
    if (ConsolePanel.current) ConsolePanel.current.panel.webview.postMessage(message);
  }

  constructor({panel, context, mediaRoot, version, onMessage}) {
    this.panel = panel;
    this.version = version;
    this.onMessage = onMessage;
    this.disposables = [];
    panel.webview.html = this.html(mediaRoot, version);
    panel.onDidDispose(() => {
      ConsolePanel.current = null;
      for (const disposable of this.disposables) disposable.dispose();
    }, null, context.subscriptions);
    this.disposables.push(panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'action' && typeof message.action === 'string') {
        Promise.resolve(this.onMessage(message)).catch(() => {});
      }
    }));
  }

  html(mediaRoot, version) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (name) => this.panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, name));
    const csp = [
      "default-src 'none'",
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${this.panel.webview.cspSource} data:`,
      `font-src ${this.panel.webview.cspSource}`
    ].join('; ');
    let template = fs.readFileSync(path.join(mediaRoot.fsPath, 'console.html'), 'utf8');
    template = template
      .replaceAll('{{csp}}', csp)
      .replaceAll('{{nonce}}', nonce)
      .replaceAll('{{cssUri}}', String(uri('console.css')))
      .replaceAll('{{scriptUri}}', String(uri('console.js')))
      .replaceAll('{{version}}', String(version || ''));
    return template;
  }
}

module.exports = {ConsolePanel};