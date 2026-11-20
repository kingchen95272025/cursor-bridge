'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createPaths} = require('./paths.js');

// Extension-side half of the control channel. The service runs detached so a
// closed window does not tear down the bridge; this module finds a healthy
// service, spawns one when none is running, and upgrades a stale one after a
// VSIX update.

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
})();

function serviceScript() {
  return path.join(__dirname, 'service.js');
}

// `process.execPath` inside an extension host is usually a Chromium helper.
// Running a helper detached is fragile (the browser process may reap it), so
// prefer the app's main executable and let ELECTRON_RUN_AS_NODE turn it into a
// plain Node runtime. The helper remains the fallback.
function inferMainExecutable(execPath) {
  if (process.platform !== 'darwin') return null;
  // Non-greedy: the helper itself is a second .app
  // (Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/...). A greedy
  // match would pick the helper and spawn a detached process Chromium reaps
  // as soon as the browser process notices it.
  const match = /^(.*?)\.app\/Contents\/Frameworks\//.exec(execPath);
  if (!match) return null;
  const app = `${match[1]}.app`;
  const name = path.basename(app).replace(/\.app$/, '');
  const candidate = path.join(app, 'Contents', 'MacOS', name);
  try { return fs.statSync(candidate).isFile() ? candidate : null; } catch { return null; }
}

function runtimeCandidates() {
  const candidates = [];
  if (process.env.CURSOR_BRIDGE_NODE) candidates.push(process.env.CURSOR_BRIDGE_NODE);
  if (process.versions.electron) {
    const main = inferMainExecutable(process.execPath);
    if (main) candidates.push(main);
  }
  candidates.push(process.execPath);
  return [...new Set(candidates.filter(Boolean))];
}

async function fetchJson(info, pathname, {timeout = 3000, method = 'GET', body} = {}) {
  const response = await fetch(`http://127.0.0.1:${info.port}${pathname}`, {
    method,
    headers: {'x-cursor-bridge-token': info.token, 'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {raw: text}; }
  if (!response.ok) throw new Error(parsed.error || `service HTTP ${response.status}`);
  return parsed;
}

async function health(info, timeout = 1200) {
  if (!info || !info.port) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {signal: AbortSignal.timeout(timeout)});
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function readServiceInfo(root) {
  try { return JSON.parse(fs.readFileSync(createPaths(root).service, 'utf8')); } catch { return null; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cleanupStale(root) {
  const paths = createPaths(root);
  try { fs.unlinkSync(paths.service); } catch { /* absent */ }
  try { fs.rmSync(paths.lock, {recursive: true, force: true}); } catch { /* absent */ }
}

function spawnService({root, runtime, noAutostart, log = () => {}}) {
  const args = [serviceScript(), '--root', root];
  if (noAutostart) args.push('--no-autostart');
  // A detached service has no visible stderr. If it dies during startup the
  // only evidence is this file, so spawn errors and early crashes land here
  // instead of disappearing into 'ignore'.
  let fd = 'ignore';
  try {
    const logDir = path.join(root, 'logs');
    fs.mkdirSync(logDir, {recursive: true, mode: 0o700});
    fd = fs.openSync(path.join(logDir, 'service-spawn.log'), 'a', 0o600);
  } catch { /* fall back to ignore */ }
  const child = spawn(runtime, args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1', CURSOR_BRIDGE_SERVICE: '1'}
  });
  child.on('error', (error) => log(`service spawn failed (${runtime}): ${error.message}`));
  child.unref();
  if (fd !== 'ignore') { try { fs.closeSync(fd); } catch { /* child keeps its copy */ } }
  return child.pid;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ServiceClient {
  constructor(info) {
    this.info = info;
  }

  get version() { return this.info?.version || null; }
  get port() { return this.info?.port || null; }

  request(pathname, options = {}) {
    return fetchJson(this.info, pathname, options);
  }

  status() { return this.request('/status'); }
  config(payload) { return this.request('/config', {method: 'POST', body: payload}); }
  start({force = false} = {}) { return this.request('/start', {method: 'POST', body: {force}, timeout: 60000}); }
  stop({restore = true} = {}) { return this.request('/stop', {method: 'POST', body: {restore}, timeout: 60000}); }
  restart({force = false} = {}) { return this.request('/restart', {method: 'POST', body: {force}, timeout: 90000}); }
  certInit() { return this.request('/cert/init', {method: 'POST', body: {}, timeout: 45000}); }
  certTrust() { return this.request('/cert/trust', {method: 'POST', body: {}, timeout: 200000}); }
  calls({limit = 100, offset = 0} = {}) { return this.request(`/calls?limit=${limit}&offset=${offset}`, {timeout: 10000}); }
  dbStats({deep = false} = {}) { return this.request(`/db/stats?deep=${deep ? 1 : 0}`, {timeout: 120000}); }
  dbPrune({days} = {}) { return this.request('/db/prune', {method: 'POST', body: {days}, timeout: 300000}); }
  dbVacuum() { return this.request('/db/vacuum', {method: 'POST', body: {}, timeout: 600000}); }
  diagnose() { return this.request('/diagnose', {method: 'POST', body: {}, timeout: 30000}); }
  logs({source = 'engine', lines = 200} = {}) { return this.request(`/logs?source=${source}&lines=${lines}`, {timeout: 10000}); }
  shutdown() { return this.request('/shutdown', {method: 'POST', body: {}, timeout: 5000}); }
}

// Returns a live client, spawning or upgrading the service as needed. `log`
// receives one-line diagnostics the extension can put in its output channel.
async function ensureService({root, log = () => {}, noAutostart = false, timeoutMs = 15000}) {
  let info = readServiceInfo(root);
  if (info && alive(info.pid)) {
    const probe = await health(info);
    if (probe?.ok) {
      if (probe.version === VERSION) return new ServiceClient(info);
      // A VSIX update replaced the code while the old service kept running.
      // Ask it to leave, then start the new build; the proxy journal survives,
      // so Cursor keeps its settings across the upgrade.
      log(`service ${probe.version} -> ${VERSION}; restarting background service`);
      try { await new ServiceClient(info).shutdown(); } catch { /* it may already be gone */ }
      await wait(600);
      cleanupStale(root);
    } else {
      cleanupStale(root);
    }
  } else if (info) {
    cleanupStale(root);
  }

  const runtime = runtimeCandidates()[0];
  log(`starting service with ${runtime}`);
  spawnService({root, runtime, noAutostart, log});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(250);
    const candidate = readServiceInfo(root);
    if (!candidate) continue;
    const probe = await health(candidate);
    if (probe?.ok) return new ServiceClient(candidate);
  }
  throw new Error(`桥接服务未能启动（运行时 ${runtime}）。请查看 ${path.join(root, 'logs', 'service.log')}`);
}

module.exports = {
  VERSION,
  ServiceClient,
  ensureService,
  readServiceInfo,
  health,
  runtimeCandidates,
  inferMainExecutable,
  cleanupStale
};