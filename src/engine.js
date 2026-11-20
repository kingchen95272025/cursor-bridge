'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');

// Thin owner of the native engine process. It knows how to start it, how to
// wait for its `{"event":"ready"}` line, how to run `--init-ca`, and how to
// stop it without leaving a zombie. All policy (when to start, what catalogue
// to feed it) belongs to the service.
class Engine {
  constructor({binary, dataDir, effectiveFile, mode = 'default', proxyPort = 0, log = () => {}, onStderr = () => {}}) {
    this.binary = binary;
    this.dataDir = dataDir;
    this.effectiveFile = effectiveFile;
    this.mode = mode;
    this.proxyPort = proxyPort;
    this.log = log;
    this.onStderr = onStderr;
    this.child = null;
    this.readyInfo = null;
  }

  get running() {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  ensureExecutable() {
    if (process.platform === 'win32') return;
    try {
      const mode = fs.statSync(this.binary).mode;
      if (!(mode & 0o111)) fs.chmodSync(this.binary, 0o755);
    } catch { /* the spawn error below carries the real message */ }
  }

  initCA() {
    return new Promise((resolve, reject) => {
      this.ensureExecutable();
      fs.mkdirSync(this.dataDir, {recursive: true, mode: 0o700});
      const child = spawn(this.binary, ['--init-ca'], {
        env: {...process.env, CURSOR_BYOK_DATA_DIR: this.dataDir},
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.on('error', (error) => { clearTimeout(timer); reject(new Error(`cannot start engine: ${error.message}`)); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`certificate initialization failed (${code}): ${stderr.trim() || stdout.trim()}`));
          return;
        }
        try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop())); }
        catch (error) { reject(new Error(`invalid certificate initialization output: ${error.message}`)); }
      });
    });
  }

  start() {
    if (this.running) return Promise.resolve(this.readyInfo);
    this.ensureExecutable();
    fs.mkdirSync(this.dataDir, {recursive: true, mode: 0o700});
    const env = {
      ...process.env,
      CURSOR_BYOK_DATA_DIR: this.dataDir,
      CURSOR_BRIDGE_RUN_MODE: this.mode
    };
    if (this.proxyPort) env.CURSOR_BRIDGE_PROXY_PORT = String(this.proxyPort);
    const child = spawn(this.binary, [this.effectiveFile], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    child.stderr.on('data', (chunk) => this.onStderr(chunk));
    child.once('exit', (code, signal) => {
      if (this.child === child) this.log(`engine exited (${signal || code})`);
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('bridge startup timed out'));
      }, 30000);
      const lines = createInterface({input: child.stdout});
      const cleanup = () => {
        clearTimeout(timer);
        lines.removeAllListeners();
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
      };
      const onError = (error) => {
        cleanup();
        reject(new Error(`cannot start bridge engine (${error.code || error.message}); the VSIX must ship a binary for this platform`));
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(`bridge engine stopped (${signal || code}); check certificate trust`));
      };
      lines.on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message?.event === 'ready') {
          cleanup();
          this.readyInfo = message;
          resolve(message);
        }
      });
      child.once('error', onError);
      child.once('exit', onExit);
    });
  }

  async stop({timeoutMs = 12000} = {}) {
    const child = this.child;
    this.child = null;
    this.readyInfo = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      try { child.kill('SIGTERM'); } catch { return resolve(); }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      }, timeoutMs);
    });
  }
}

module.exports = {Engine};