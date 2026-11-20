'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const platform = require('../lib/platform.js');
const {atomic} = require('../lib/settings.js');
const {parse: parseJsonc, modify, applyEdits} = require('../vendor/jsonc-parser/lib/umd/main.js');

// The engine terminates TLS with a local CA. Cursor must trust that CA before
// any request can succeed; until then the proxy must not be applied, or the
// user loses all network access inside Cursor. Every probe and every trust
// action lives here so the console can say exactly which step is missing.

const AUTHORITY_KEY = 'certificate-authority';
const NSS_NICKNAME = 'Cursor BYOK Local CA';

function run(command, args, {timeout = 30000} = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {timeout, windowsHide: true, encoding: 'utf8'}, (error, stdout, stderr) => {
      const status = !error ? 0 : (Number.isInteger(error.code) ? error.code : -1);
      resolve({status, stdout: stdout || '', stderr: stderr || '', error: error ? String(error.message || error) : null});
    });
  });
}

function certificateThumbprint(file) {
  const pem = fs.readFileSync(file, 'utf8');
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  return crypto.createHash('sha1').update(der).digest('hex').toUpperCase();
}

function certificateSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').trim()).digest('hex');
}

function powershellExecutable() {
  return platform.findExecutable(['powershell', 'pwsh']) || 'powershell';
}

function machineRootTrusted(cert) {
  const thumbprint = certificateThumbprint(cert);
  const script = `(Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object { $_.Thumbprint -eq '${thumbprint}' } | Select-Object -First 1).Thumbprint`;
  return run(powershellExecutable(), ['-NoProfile', '-NonInteractive', '-Command', script], {timeout: 30000})
    .then((result) => ({thumbprint, trusted: String(result.stdout || '').trim().toUpperCase() === thumbprint}));
}

async function trustWindowsCertificate(cert) {
  const first = await machineRootTrusted(cert);
  if (first.trusted) return {ok: true, already: true};
  const certutil = platform.findExecutable([
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'certutil.exe'),
    'certutil'
  ]) || 'certutil';
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = `$p=Start-Process -FilePath ${quote(certutil)} -ArgumentList @('-addstore','Root',${quote(cert)}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
  await run(powershellExecutable(), ['-NoProfile', '-NonInteractive', '-Command', script], {timeout: 150000});
  const verify = await machineRootTrusted(cert);
  return {ok: verify.trusted, already: false};
}

function cursorAuthority(file) {
  if (!file) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const errors = [];
    const data = parseJsonc(text, errors, {allowTrailingComma: true});
    if (errors.length || !data || typeof data !== 'object' || Array.isArray(data)) return null;
    return typeof data[AUTHORITY_KEY] === 'string' ? data[AUTHORITY_KEY] : null;
  } catch {
    return null;
  }
}

function writeCursorAuthority(file, cert) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{\n}\n';
  const errors = [];
  const data = parseJsonc(text, errors, {allowTrailingComma: true});
  if (errors.length || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Cursor 的 argv.json 格式无法解析：${file}`);
  }
  if (data[AUTHORITY_KEY] === cert) return false;
  const pending = modify(text, [AUTHORITY_KEY], cert, {
    formattingOptions: {insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n'}
  });
  atomic(file, applyEdits(text, pending));
  return true;
}

// `certutil` here is NSS's tool (nss-tools), not Windows' certificate utility:
// it edits ~/.pki/nssdb, the store Chromium/Electron falls back to.
async function trustLinuxNss(cert, home) {
  const database = platform.nssDatabaseFor(home);
  const certutil = platform.findExecutable(['certutil']);
  if (!database || !certutil) return {imported: false, reason: 'no-certutil'};
  fs.mkdirSync(database, {recursive: true, mode: 0o700});
  if (!fs.existsSync(path.join(database, 'cert9.db')) && !fs.existsSync(path.join(database, 'cert8.db'))) {
    await run(certutil, ['-d', `sql:${database}`, '-N', '--empty-password'], {timeout: 15000});
    if (!fs.existsSync(path.join(database, 'cert9.db')) && !fs.existsSync(path.join(database, 'cert8.db'))) {
      return {imported: false, reason: 'no-database'};
    }
  }
  await run(certutil, ['-d', `sql:${database}`, '-D', '-n', NSS_NICKNAME], {timeout: 15000});
  const added = await run(certutil, ['-d', `sql:${database}`, '-A', '-t', 'C,,', '-n', NSS_NICKNAME, '-i', cert], {timeout: 15000});
  if (added.status !== 0) return {imported: false, reason: 'add-failed'};
  return {imported: true, reason: ''};
}

// The engine refuses to start unless it considers the CA trusted. On Linux it
// reads this marker in addition to the system anchor and Cursor's argv.json.
function writeLinuxTrustMarker(cert, root, method = 'nss') {
  const file = path.join(root, 'data', 'ca', 'trusted.json');
  atomic(file, JSON.stringify({
    sha256: certificateSha256(cert),
    method,
    file: cert,
    imported: new Date().toISOString()
  }, null, 2) + '\n');
  return file;
}

function linuxMarkerTrusted(cert, root) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(root, 'data', 'ca', 'trusted.json'), 'utf8'));
    return marker.sha256 === certificateSha256(cert);
  } catch {
    return false;
  }
}

async function isTrusted(cert, home, root) {
  if (!fs.existsSync(cert)) return {trusted: false, reason: 'missing', detail: '本地 CA 尚未初始化'};
  if (platform.IS_DARWIN) {
    const result = await run('/usr/bin/security', ['verify-cert', '-c', cert, '-p', 'ssl'], {timeout: 20000});
    return result.status === 0
      ? {trusted: true, reason: 'keychain', detail: '系统钥匙串已信任'}
      : {trusted: false, reason: 'untrusted', detail: 'macOS 钥匙串尚未信任该证书'};
  }
  if (platform.IS_WIN) {
    const result = await machineRootTrusted(cert);
    return result.trusted
      ? {trusted: true, reason: 'machine-root', detail: '本机受信任根存储已包含该证书'}
      : {trusted: false, reason: 'untrusted', detail: '本机受信任根存储尚未包含该证书'};
  }
  const argv = platform.cursorArgvFor(home);
  if (cursorAuthority(argv) === cert) return {trusted: true, reason: 'argv', detail: 'Cursor argv.json 已指向该证书'};
  if (linuxMarkerTrusted(cert, root)) return {trusted: true, reason: 'marker', detail: '已通过 NSS 导入'};
  return {trusted: false, reason: 'untrusted', detail: 'Cursor argv.json 尚未信任该证书'};
}

async function trust(cert, home, root) {
  if (!fs.existsSync(cert)) throw new Error('本地 CA 尚未初始化，请先运行证书初始化');
  if (platform.IS_DARWIN) {
    await run('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl',
      '-k', path.join(home, 'Library/Keychains/login.keychain-db'), cert], {timeout: 150000});
    const verify = await run('/usr/bin/security', ['verify-cert', '-c', cert, '-p', 'ssl'], {timeout: 20000});
    if (verify.status !== 0) throw new Error('macOS 证书信任未完成；请在弹出的授权窗口中确认后重试');
    return {ok: true, method: 'keychain'};
  }
  if (platform.IS_WIN) {
    const result = await trustWindowsCertificate(cert);
    if (!result.ok) throw new Error('证书未加入本机受信任的根证书；请在管理员确认窗口选择「是」后重试');
    return {ok: true, method: 'machine-root'};
  }
  const argv = platform.cursorArgvFor(home);
  writeCursorAuthority(argv, cert);
  const nss = await trustLinuxNss(cert, home);
  writeLinuxTrustMarker(cert, root, nss.imported ? 'nss' : 'argv');
  return {ok: true, method: nss.imported ? 'nss+argv' : 'argv'};
}

module.exports = {
  AUTHORITY_KEY,
  certificateThumbprint,
  certificateSha256,
  cursorAuthority,
  writeCursorAuthority,
  trustLinuxNss,
  writeLinuxTrustMarker,
  isTrusted,
  trust
};