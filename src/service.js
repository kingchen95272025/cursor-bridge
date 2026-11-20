'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const {createPaths} = require('./paths.js');
const {FileLog} = require('./log.js');
const configStore = require('./config.js');
const providers = require('./providers.js');
const catalogue = require('./catalogue.js');
const {createShim} = require('./shim.js');
const {Engine} = require('./engine.js');
const {CallStore} = require('./calls.js');
const conflicts = require('./conflicts.js');
const certificates = require('./certificates.js');
const rescue = require('./rescue.js');
const database = require('./database.js');
const diagnostics = require('./diagnostics.js');
const platform = require('../lib/platform.js');
const {applyProxy, restoreProxy, proxyState, atomic} = require('../lib/settings.js');

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
})();

const EXTENSION_ROOT = path.resolve(__dirname, '..');

// The service is the bridge. It outlives any single Cursor window: the
// extension spawns it detached, then talks to it over a loopback control port.
// Keeping the engine and the shim in one long-lived process is what makes
// "close the window, reopen Cursor, keep working" true without installing a
// LaunchAgent or a systemd unit.
class BridgeService {
  constructor({root, noAutostart = false}) {
    this.root = root;
    this.paths = createPaths(root);
    // Tests and portable installs point at a throwaway home/settings file;
    // the production path is the real Cursor profile.
    this.home = process.env.CURSOR_BRIDGE_HOME || os.homedir();
    this.settingsFile = process.env.CURSOR_BRIDGE_SETTINGS || platform.cursorSettingsFor(this.home);
    this.noAutostart = noAutostart;
    this.log = new FileLog(this.paths.serviceLog, 2 * 1024 * 1024);
    this.config = configStore.read(root);
    this.secrets = {};
    this.state = 'starting';
    this.detail = null;
    this.serviceInfo = null;
    this.server = null;

    this.shim = null;
    this.shimPort = 0;
    this.shimToken = '';

    this.engine = null;
    this.engineInfo = null;

    this.providersMap = new Map();
    this.refreshed = [];
    this.providerProblems = [];
    this.catalogue = {models: [], groups: []};

    this.certInfo = {exists: false, trusted: false, path: this.paths.caCert};
    this.proxyInfo = {expected: null, current: null, journaled: false, active: false, restartRequired: false};
    this.conflicts = {detected: false, items: []};
    this.calls = new CallStore(this.paths.calls, {retentionDays: 30});
    this.backupFile = null;

    this.starting = false;
    this.stoppingEngine = false;
    this.traffic = false;
    this.proxyAppliedAt = 0;
    this.engineFailures = 0;
    this.lastEffective = '';
    this.timers = [];
    this.lockDir = this.paths.lock;
  }

  runtime() {
    const value = this.config.runtime || {};
    return {
      proxyPort: Number(value.proxyPort) || 58160,
      runMode: value.runMode === 'lite' ? 'lite' : 'default',
      refreshSeconds: Math.max(5, Number(value.refreshSeconds) || 15),
      logLimitMB: Math.max(1, Number(value.logLimitMB) || 4),
      tracesRetentionDays: Math.max(0, Number(value.tracesRetentionDays) || 0)
    };
  }

  setState(state, detail = null) {
    const changed = this.state !== state || this.detail !== detail;
    this.state = state;
    this.detail = detail;
    if (changed) {
      this.log.line(`state=${state}${detail ? ` detail=${detail}` : ''}`);
      this.publish();
    }
  }

  publish() {
    try {
      atomic(this.paths.status, JSON.stringify({...this.snapshot(), updatedAt: new Date().toISOString()}, null, 2));
    } catch { /* the console also polls the control port */ }
  }

  async run() {
    fs.mkdirSync(this.root, {recursive: true, mode: 0o700});
    fs.mkdirSync(this.paths.data, {recursive: true, mode: 0o700});
    fs.mkdirSync(this.paths.logs, {recursive: true, mode: 0o700});
    fs.mkdirSync(this.paths.calls, {recursive: true, mode: 0o700});
    this.acquireLock();
    await this.startControlServer();
    this.log.line(`service ${VERSION} started (pid ${process.pid})`);

    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => { this.shutdown().finally(() => process.exit(0)); });
    }

    this.timers.push(setInterval(() => this.tick(), 2000));
    this.timers.push(setInterval(() => this.refreshTick(), this.runtime().refreshSeconds * 1000));
    this.timers.push(setInterval(() => this.retentionTick(), 6 * 60 * 60 * 1000));
    this.timers.push(setInterval(() => this.publish(), 5000));

    this.publish();
    if (!this.noAutostart && this.config.providers.some((provider) => provider.enabled)) {
      await this.ensureStarted({reason: 'autostart'});
    } else {
      this.setState(this.config.providers.length ? 'stopped' : 'unconfigured',
        this.config.providers.length ? '已配置，等待手动启用' : '尚未配置任何提供者');
    }
  }

  acquireLock() {
    try {
      fs.mkdirSync(this.lockDir);
      fs.writeFileSync(path.join(this.lockDir, 'pid'), String(process.pid), {mode: 0o600});
    } catch {
      let pid = 0;
      try { pid = Number(fs.readFileSync(path.join(this.lockDir, 'pid'), 'utf8')); } catch { /* no pid file */ }
      let alive = false;
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      }
      if (alive) throw new Error(`another bridge service is already running (pid ${pid})`);
      fs.rmSync(this.lockDir, {recursive: true, force: true});
      fs.mkdirSync(this.lockDir);
      fs.writeFileSync(path.join(this.lockDir, 'pid'), String(process.pid), {mode: 0o600});
    }
  }

  releaseLock() {
    try { fs.rmSync(this.lockDir, {recursive: true, force: true}); } catch { /* already gone */ }
  }

  startControlServer() {
    this.shimToken = this.shimToken || crypto.randomBytes(24).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    this.controlToken = token;
    this.server = http.createServer((req, res) => this.handle(req, res, token));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        const address = this.server.address();
        this.serviceInfo = {pid: process.pid, port: address.port, token, root: this.root, version: VERSION, startedAt: new Date().toISOString()};
        atomic(this.paths.service, JSON.stringify(this.serviceInfo, null, 2));
        resolve();
      });
    });
  }

  // ---- control plane -----------------------------------------------------

  async handle(req, res, token) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store'});
      res.end(text);
    };
    if (req.method === 'GET' && url.pathname === '/health') {
      send(200, {ok: true, service: 'cursor-bridge', pid: process.pid, version: VERSION});
      return;
    }
    if (String(req.headers['x-cursor-bridge-token'] || '') !== token) {
      send(401, {error: 'invalid service token'});
      return;
    }
    try {
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
      const action = `${req.method} ${url.pathname}`;
      if (action === 'GET /status') return send(200, this.snapshot());
      if (action === 'POST /config') {
        const saved = await this.applyConfig(body);
        return send(200, {ok: true, config: saved, status: this.snapshot()});
      }
      if (action === 'POST /start') {
        await this.ensureStarted({force: body.force === true, reason: 'manual'});
        return send(200, {ok: this.state !== 'error', status: this.snapshot()});
      }
      if (action === 'POST /stop') {
        await this.stopBridge({restore: body.restore !== false});
        return send(200, {ok: true, status: this.snapshot()});
      }
      if (action === 'POST /restart') {
        await this.restartBridge({force: body.force === true});
        return send(200, {ok: true, status: this.snapshot()});
      }
      if (action === 'POST /cert/init') {
        await this.initCertificate();
        return send(200, {ok: true, cert: this.certInfo});
      }
      if (action === 'POST /cert/trust') {
        await this.trustCertificate();
        return send(200, {ok: true, cert: this.certInfo, status: this.snapshot()});
      }
      if (action === 'GET /calls') {
        return send(200, {
          rows: this.calls.list({limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset')}),
          summary: this.calls.summary()
        });
      }
      if (action === 'GET /db/stats') {
        return send(200, database.stats(this.paths.bridgeDb, {deep: url.searchParams.get('deep') === '1'}));
      }
      if (action === 'POST /db/prune') {
        const days = Number(body.days) || this.runtime().tracesRetentionDays;
        const backup = database.backup(this.paths.bridgeDb, this.paths.backups);
        return send(200, {...database.pruneTraces(this.paths.bridgeDb, {days}), backup});
      }
      if (action === 'POST /db/vacuum') {
        return send(200, await this.vacuumDatabase());
      }
      if (action === 'POST /diagnose') {
        return send(200, diagnostics.run(this.snapshot()));
      }
      if (action === 'GET /logs') {
        const source = url.searchParams.get('source') === 'service' ? this.paths.serviceLog : this.paths.engineLog;
        const lines = Math.min(2000, Math.max(20, Number(url.searchParams.get('lines')) || 200));
        return send(200, {source: source === this.paths.serviceLog ? 'service' : 'engine', text: new FileLog(source, 0).tail(lines)});
      }
      if (action === 'POST /shutdown') {
        send(200, {ok: true});
        setTimeout(() => this.shutdown().finally(() => process.exit(0)), 50);
        return;
      }
      send(404, {error: `unknown route ${action}`});
    } catch (error) {
      this.log.line(`control error: ${error.message}`);
      send(500, {error: String(error.message || error)});
    }
  }

  // ---- configuration -----------------------------------------------------

  async applyConfig({config, secrets}) {
    const previousRuntime = this.runtime();
    this.config = configStore.write(this.root, config);
    if (secrets && typeof secrets === 'object') {
      this.secrets = {};
      for (const [id, value] of Object.entries(secrets)) {
        if (typeof value === 'string' && value.trim()) this.secrets[id] = value.trim();
      }
    }
    const nextRuntime = this.runtime();
    if ((nextRuntime.proxyPort !== previousRuntime.proxyPort || nextRuntime.runMode !== previousRuntime.runMode)
      && (this.engine?.running || this.shim)) {
      // A port change invalidates the address Cursor already stored, and a mode
      // change is only read at engine start. Both need a clean stop/start; the
      // proxy is restored first so the journal never points at a dead port.
      await this.stopBridge({restore: true});
      await this.ensureStarted({force: true, reason: 'runtime change'});
      return configStore.read(this.root);
    }
    // A freshly spawned service starts from config.json and may not have the
    // secrets yet; the extension pushes them right after spawn. Re-resolving
    // the provider table here makes that hand-off invisible to the user: a
    // key that arrives now is used by the very next refresh.
    const resolved = providers.resolve(this.config.providers, this.secrets, this.home);
    this.providerProblems = resolved.problems;
    this.providersMap = new Map(resolved.providers.map((provider) => [provider.id, provider]));
    if (this.engine?.running || this.shim) {
      await this.refreshCatalogue({silent: true}).catch((error) => this.log.line(`config refresh failed: ${error.message}`));
    }
    const wantsBridge = this.config.providers.some((provider) => provider.enabled);
    if (wantsBridge && !['connected', 'needs-restart', 'starting', 'cert-missing', 'conflict', 'paused'].includes(this.state)) {
      await this.ensureStarted({force: true, reason: 'config'});
    } else if (!wantsBridge && this.engine?.running) {
      await this.stopBridge({restore: true});
      this.setState('unconfigured', '所有提供者均已停用');
    } else if (this.engine?.running) {
      await this.refreshCatalogue({silent: true}).catch(() => {});
    }
    this.publish();
    return configStore.read(this.root);
  }

  // ---- lifecycle ---------------------------------------------------------

  createEngine() {
    const runtime = this.runtime();
    return new Engine({
      binary: platform.enginePathFor(EXTENSION_ROOT),
      dataDir: this.paths.data,
      effectiveFile: this.paths.effective,
      mode: runtime.runMode,
      proxyPort: runtime.proxyPort,
      log: (line) => this.log.line(line),
      onStderr: (chunk) => this.engineLogSink(chunk)
    });
  }

  engineLogSink(chunk) {
    if (!this.engineLog) this.engineLog = new FileLog(this.paths.engineLog, this.runtime().logLimitMB * 1024 * 1024);
    this.engineLog.write(chunk.toString('utf8'));
  }

  async initCertificate() {
    if (!this.engine) this.engine = this.createEngine();
    const result = await this.engine.initCA();
    const trust = await certificates.isTrusted(this.paths.caCert, this.home, this.root);
    this.certInfo = {path: this.paths.caCert, exists: fs.existsSync(this.paths.caCert), ...trust, init: result};
    this.publish();
    return this.certInfo;
  }

  async ensureCertificate() {
    if (!fs.existsSync(this.paths.caCert)) {
      await this.initCertificate();
    }
    const trust = await certificates.isTrusted(this.paths.caCert, this.home, this.root);
    this.certInfo = {path: this.paths.caCert, exists: fs.existsSync(this.paths.caCert), ...trust};
    return this.certInfo;
  }

  async trustCertificate() {
    await this.ensureCertificate();
    if (!this.certInfo.trusted) {
      await certificates.trust(this.paths.caCert, this.home, this.root);
    }
    const trust = await certificates.isTrusted(this.paths.caCert, this.home, this.root);
    this.certInfo = {path: this.paths.caCert, exists: true, ...trust};
    this.publish();
    // Trust usually lands in a store Cursor only reads at startup, so the
    // proxy stays off until the certificate is actually recognized.
    if (this.certInfo.trusted) await this.ensureStarted({force: true, reason: 'cert-trust'});
    return this.certInfo;
  }

  async ensureStarted({force = false, reason = ''} = {}) {
    if (this.starting) return;
    this.starting = true;
    if (!this.engine) this.engine = this.createEngine();
    try {
      this.setState('starting', reason ? `启动中（${reason}）` : '启动中');

      this.conflicts = conflicts.detect({
        home: this.home,
        settings: this.settingsState(),
        expectedProxy: this.engineInfo?.proxy || null
      });
      if (this.conflicts.detected && !force) {
        this.setState('conflict', this.conflicts.items[0]?.title || '检测到其他桥接在运行');
        return;
      }

      const cert = await this.ensureCertificate();
      if (!cert.trusted) {
        this.setState('cert-missing', cert.detail || '本地 CA 尚未受信任');
        return;
      }

      const resolved = providers.resolve(this.config.providers, this.secrets, this.home);
      this.providerProblems = resolved.problems;
      if (!resolved.providers.length) {
        this.setState('unconfigured', resolved.problems[0]?.message || '没有可用的提供者');
        return;
      }
      this.providersMap = new Map(resolved.providers.map((provider) => [provider.id, provider]));

      if (!this.shim) {
        this.shim = createShim({
          token: this.shimToken,
          getProviders: () => this.providersMap,
          getCatalogue: () => this.catalogue,
          onCall: (entry) => this.onCall(entry),
          log: (line) => this.log.line(line)
        });
        const info = await this.shim.start(0);
        this.shimPort = info.port;
      }

      await this.refreshCatalogue({silent: true});
      if (!this.catalogue.models.length) {
        this.setState('error', '没有可用模型：请检查提供者配置与密钥');
        return;
      }

      this.writeEffective();
      if (!this.engine.running) {
        this.engineInfo = await this.engine.start();
        this.log.line(`engine ready: ${this.engineInfo.proxy}`);
      }

      this.applyProxyForEngine();
      this.engineFailures = 0;
      this.setState(this.proxyInfo.restartRequired ? 'needs-restart' : 'connected',
        this.proxyInfo.restartRequired ? '代理已写入，请重启 Cursor 以生效' : null);
    } catch (error) {
      this.log.line(`start failed: ${error.message}`);
      this.setState('error', String(error.message || error));
    } finally {
      this.starting = false;
      this.publish();
    }
  }

  async stopBridge({restore = true} = {}) {
    this.log.line(`stop requested (restore=${restore})`);
    this.stoppingEngine = true;
    try {
      if (this.engine) await this.engine.stop();
      if (restore) {
        try { restoreProxy(this.paths.journal); } catch (error) { this.log.line(`restore proxy failed: ${error.message}`); }
      }
      if (this.shim) await this.shim.stop();
      this.shim = null;
      this.shimPort = 0;
      this.engineInfo = null;
      this.proxyInfo = {...this.proxyInfo, active: false, restartRequired: false};
      this.setState('stopped', restore ? '已停止并还原代理' : '已停止');
    } finally {
      this.stoppingEngine = false;
      this.publish();
    }
  }

  async restartBridge({force = false} = {}) {
    this.log.line('restart requested');
    this.stoppingEngine = true;
    try {
      if (this.engine) await this.engine.stop();
      if (this.shim) await this.shim.stop();
      this.shim = null;
      this.shimPort = 0;
      this.engineInfo = null;
    } finally {
      this.stoppingEngine = false;
    }
    this.lastEffective = '';
    await this.ensureStarted({force, reason: 'restart'});
  }

  // ---- catalogue and proxy ----------------------------------------------

  async refreshCatalogue({silent = false} = {}) {
    if (!this.providersMap.size) return;
    const list = [...this.providersMap.values()];
    const previous = new Map(this.refreshed.map((entry) => [entry.provider.id, entry]));
    const refreshed = await Promise.all(list.map((provider) => providers.refreshProvider(provider, previous.get(provider.id) || null)));
    this.refreshed = refreshed;
    const built = catalogue.build(refreshed, this.config.modelPrefs);
    this.catalogue = built;
    if (this.engine?.running) {
      try { this.writeEffective(); } catch (error) { if (!silent) throw error; }
    }
    this.lastRefreshAt = Date.now();
    this.publish();
  }

  writeEffective() {
    const defaultModel = catalogue.pickDefault(this.catalogue.models, this.config.selectedModel);
    if (!defaultModel) throw new Error('模型目录为空，无法启动引擎');
    const effective = {
      gateway: `http://127.0.0.1:${this.shimPort}/v1`,
      key: this.shimToken,
      model: defaultModel,
      models: this.catalogue.models.map((model) => ({id: model.id, name: model.name, context: model.context}))
    };
    const text = JSON.stringify(effective, null, 2);
    if (text === this.lastEffective) return;
    atomic(this.paths.effective, text);
    this.lastEffective = text;
    this.selectedModel = defaultModel;
  }

  settingsState() {
    const expected = this.engineInfo?.proxy || null;
    try {
      return proxyState(this.settingsFile, this.paths.journal, expected);
    } catch {
      return {journaled: fs.existsSync(this.paths.journal), current: null, expected, active: false};
    }
  }

  applyProxyForEngine() {
    const expected = this.engineInfo?.proxy;
    if (!expected) return;
    const settingsFile = this.settingsFile;
    const state = proxyState(settingsFile, this.paths.journal, expected);
    this.proxyInfo = {
      expected,
      current: state.current,
      journaled: state.journaled,
      active: state.active,
      restartRequired: this.proxyInfo.restartRequired
    };
    if (state.journaled && !state.active) {
      // Someone edited http.proxy behind our back. Rewriting it would fight
      // the other owner; the console asks for an explicit "force take over".
      this.setState('paused', 'Cursor 代理设置被外部改动，桥接已暂停');
      return;
    }
    if (state.active) return;
    const journalExisted = fs.existsSync(this.paths.journal);
    if (!journalExisted) {
      this.backupFile = rescue.backupSettings(settingsFile, this.paths.backups);
    }
    if (!this.backupFile) {
      try {
        const files = fs.readdirSync(this.paths.backups).filter((name) => /^settings-.*\.json$/.test(name)).sort().reverse();
        if (files.length) this.backupFile = path.join(this.paths.backups, files[0]);
      } catch { /* no backups yet */ }
    }
    rescue.writeScripts({
      home: this.home,
      settingsFile,
      backupFile: this.backupFile,
      journalFile: this.paths.journal,
      proxyUrl: expected
    });
    applyProxy(settingsFile, this.paths.journal, expected);
    this.proxyAppliedAt = Date.now();
    this.proxyInfo = {...this.proxyInfo, journaled: true, active: true, current: expected, restartRequired: true};
    this.publish();
  }

  onCall(entry) {
    this.calls.record(entry);
    this.traffic = true;
    if (this.proxyInfo.restartRequired) {
      // A request arrived through the MITM proxy, which proves this Cursor
      // process already reads the new http.proxy. No restart prompt needed.
      this.proxyInfo.restartRequired = false;
      if (this.state === 'needs-restart') this.setState('connected');
    }
  }

  // ---- timers ------------------------------------------------------------

  tick() {
    try {
      if (this.engineInfo) {
        const settings = this.settingsState();
        const expected = this.engineInfo.proxy;
        this.proxyInfo = {
          ...this.proxyInfo,
          expected,
          current: settings.current,
          journaled: settings.journaled,
          active: settings.current === expected
        };
        if (settings.journaled && settings.current !== expected && this.state === 'connected') {
          this.setState('paused', 'Cursor 代理设置被外部改动，桥接已暂停');
        }
      }
      if (!this.stoppingEngine && !this.engine?.running
        && ['connected', 'needs-restart', 'paused'].includes(this.state)) {
        this.recoverEngine();
      }
    } catch (error) {
      this.log.line(`tick failed: ${error.message}`);
    }
  }

  async recoverEngine() {
    if (this.starting) return;
    this.engineFailures += 1;
    if (this.engineFailures > 5) {
      this.setState('error', '引擎连续退出；请查看引擎日志');
      return;
    }
    const delay = Math.min(15000, 1500 * this.engineFailures);
    this.log.line(`engine exited unexpectedly; restarting in ${delay}ms (attempt ${this.engineFailures})`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.stoppingEngine) return;
    try {
      this.engine = this.createEngine();
      this.writeEffective();
      this.engineInfo = await this.engine.start();
      this.applyProxyForEngine();
      this.setState('connected');
    } catch (error) {
      this.log.line(`engine restart failed: ${error.message}`);
      this.setState('error', String(error.message || error));
    }
  }

  refreshTick() {
    if (!this.engine?.running) return;
    this.refreshCatalogue({silent: true}).catch((error) => this.log.line(`catalogue refresh failed: ${error.message}`));
  }

  retentionTick() {
    try { this.calls.prune({days: 30}); } catch { /* non-fatal */ }
    const days = this.runtime().tracesRetentionDays;
    if (days > 0 && fs.existsSync(this.paths.bridgeDb)) {
      try { database.pruneTraces(this.paths.bridgeDb, {days}); } catch (error) { this.log.line(`retention failed: ${error.message}`); }
    }
  }

  async vacuumDatabase() {
    const wasRunning = !!this.engine?.running;
    if (wasRunning) await this.engine.stop();
    try {
      const backup = database.backup(this.paths.bridgeDb, this.paths.backups);
      return {...database.vacuum(this.paths.bridgeDb), backup, pausedEngine: wasRunning};
    } finally {
      if (wasRunning) {
        try {
          this.writeEffective();
          this.engineInfo = await this.engine.start();
          this.applyProxyForEngine();
          this.setState('connected');
        } catch (error) {
          this.setState('error', `VACUUM 后引擎未能重启：${error.message}`);
        }
      }
    }
  }

  snapshot() {
    const calls = (() => { try { return this.calls.summary(); } catch { return null; } })();
    let db = {driver: null, sizeBytes: 0, file: this.paths.bridgeDb};
    try {
      const availability = database.driver();
      db = {driver: availability.driver, detail: availability.detail, sizeBytes: database.fileSize(this.paths.bridgeDb), file: this.paths.bridgeDb};
    } catch { /* ignore */ }
    return {
      version: VERSION,
      state: this.state,
      detail: this.detail,
      service: {running: true, port: this.serviceInfo?.port || null, pid: process.pid, startedAt: this.serviceInfo?.startedAt || null},
      engine: {
        running: !!this.engine?.running,
        pid: this.engine?.running ? this.engine.child?.pid : null,
        proxy: this.engineInfo?.proxy || null,
        backend: this.engineInfo?.backend || null,
        mode: this.runtime().runMode
      },
      shim: {running: !!this.shim, port: this.shimPort || null},
      cert: this.certInfo,
      proxy: this.proxyInfo,
      conflicts: this.conflicts,
      providers: this.refreshed.map((entry) => ({
        id: entry.provider.id,
        name: entry.provider.name,
        type: entry.provider.type,
        baseUrl: entry.provider.baseUrl,
        models: entry.models?.length || 0,
        error: entry.error || null,
        hasKey: !!entry.provider.key,
        refreshedAt: entry.refreshedAt
      })),
      providerProblems: this.providerProblems,
      catalogue: {
        count: this.catalogue.models.length,
        defaultModel: this.selectedModel || catalogue.pickDefault(this.catalogue.models, this.config.selectedModel),
        groups: this.catalogue.groups.map((group) => ({
          providerId: group.providerId,
          providerName: group.providerName,
          error: group.error,
          models: group.models.map((model) => ({id: model.id, upstreamId: model.upstreamId, name: model.name, context: model.context}))
        }))
      },
      calls,
      db,
      config: this.publicConfig(),
      runtime: this.runtime(),
      proxyAppliedAt: this.proxyAppliedAt || null,
      traffic: this.traffic,
      updatedAt: new Date().toISOString()
    };
  }

  publicConfig() {
    return {
      version: this.config.version,
      providers: this.config.providers.map((provider) => ({...provider})),
      modelPrefs: this.config.modelPrefs,
      selectedModel: this.selectedModel || this.config.selectedModel,
      onboardingDone: this.config.onboardingDone
    };
  }

  async shutdown() {
    this.log.line('service shutting down');
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    try { await this.engine?.stop(); } catch { /* best effort */ }
    try { await this.shim?.stop(); } catch { /* best effort */ }
    try { fs.unlinkSync(this.paths.service); } catch { /* already gone */ }
    this.releaseLock();
    await new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { reject(new Error('control body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(new Error(`invalid JSON body: ${error.message}`)); }
    });
    req.on('error', reject);
  });
}

// ---- entry point ---------------------------------------------------------

function parseArgs(argv) {
  const args = {root: null, noAutostart: false};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--root') args.root = argv[index + 1];
    else if (argv[index] === '--no-autostart') args.noAutostart = true;
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  if (!args.root) {
    console.error('usage: service.js --root <globalStoragePath> [--no-autostart]');
    process.exit(2);
  }
  const service = new BridgeService({root: args.root, noAutostart: args.noAutostart});
  service.run().catch((error) => {
    console.error(String(error.message || error));
    process.exit(1);
  });
}

module.exports = {BridgeService, parseArgs, readJson};