const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every OS-specific path and command lives here. The rest of the code asks
// this module instead of spelling out /usr/bin/open, %APPDATA% or
// Library/LaunchAgents, so a platform that lacks a capability gets one clear
// answer instead of a ENOENT halfway through an action.
//
// The *For() helpers take platform and environment explicitly so tests can
// cover all three layouts on any host; the exported constants bind them to
// the machine this process actually runs on.
const platform = process.platform;
const IS_DARWIN = platform === 'darwin';
const IS_WIN = platform === 'win32';
const IS_LINUX = platform === 'linux';

const join = (plat) => (plat === 'win32' ? path.win32 : path.posix);
const exts = (environment, plat) => plat === 'win32'
  ? String(environment.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((ext) => ext.toLowerCase()).filter(Boolean)
  : [''];

function executable(name, {plat = platform, environment = process.env} = {}) {
  const p = join(plat);
  if (p.isAbsolute(name)) {
    try { return fs.statSync(name).isFile() ? name : null; } catch { return null; }
  }
  const dirs = String(environment.PATH || environment.Path || '').split(p.delimiter).filter(Boolean);
  const suffixes = exts(environment, plat);
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = p.join(dir, name + suffix);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

// Candidate order matters: prefer a well-known absolute path, then PATH.
function findExecutable(names, options = {}) {
  for (const name of names) {
    const found = executable(name, options);
    if (found) return found;
  }
  return null;
}

// Where Magpie itself may have written `connection.json`. The VSIX never owns
// this file: it is read-only input for the Magpie provider, so an existing
// Magpie install keeps working exactly as before.
function connectionFilesFor(home, plat = platform, environment = process.env) {
  const p = join(plat);
  if (plat === 'win32') {
    const roaming = p.join(environment.APPDATA || p.join(home, 'AppData', 'Roaming'), 'magpie-cursor-bridge', 'connection.json');
    const fallback = p.join(home, '.config', 'magpie-cursor-bridge', 'connection.json');
    return [roaming, fallback];
  }
  if (plat === 'linux') {
    // Magpie's sandbox cannot read process.env, so agent-platform.js always
    // expands `~` and writes under ~/.config even when XDG_CONFIG_HOME points
    // elsewhere. That historical path therefore wins; the XDG one is only a
    // fallback for a profile that was moved there by hand.
    const historical = p.join(home, '.config', 'magpie-cursor-bridge', 'connection.json');
    const preferred = p.join(environment.XDG_CONFIG_HOME || p.join(home, '.config'), 'magpie-cursor-bridge', 'connection.json');
    return preferred === historical ? [historical] : [historical, preferred];
  }
  return [p.join(home, '.config', 'magpie-cursor-bridge', 'connection.json')];
}

function cursorSettingsFor(home, plat = platform, environment = process.env) {
  const p = join(plat);
  if (plat === 'win32') {
    return p.join(environment.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'settings.json');
  }
  if (plat === 'linux') {
    return p.join(environment.XDG_CONFIG_HOME || p.join(home, '.config'), 'Cursor', 'User', 'settings.json');
  }
  return p.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json');
}

// Linux trust has two user-level homes and both need a path here:
//  - Cursor reads `certificate-authority` from <config-home>/Cursor/argv.json;
//  - Chromium falls back to the per-user NSS database in ~/.pki/nssdb, which
//    the extension updates with `certutil -A` when nss-tools is present.
function cursorArgvFor(home, plat = platform, environment = process.env) {
  if (plat !== 'linux') return null;
  const p = join(plat);
  return p.join(environment.XDG_CONFIG_HOME || p.join(home, '.config'), 'Cursor', 'argv.json');
}

function nssDatabaseFor(home, plat = platform) {
  if (plat !== 'linux') return null;
  return join(plat).join(home, '.pki', 'nssdb');
}

function cursorDirFor(home, plat = platform, environment = process.env) {
  const p = join(plat);
  if (plat === 'win32') {
    const local = environment.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    for (const candidate of [p.join(local, 'Programs', 'cursor'), p.join(local, 'Programs', 'Cursor')]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return p.join(local, 'Programs', 'cursor');
  }
  if (plat === 'linux') {
    for (const candidate of ['/usr/share/cursor', '/opt/cursor', '/opt/Cursor']) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return 'cursor';
  }
  return '/Applications/Cursor.app';
}

// Cursor ships its version in the Electron app package. macOS uses
// Contents/Resources/app, Windows/Linux use resources/app. A missing or
// malformed file is not fatal: the console simply shows "未检测到".
function cursorVersionFrom(directory) {
  if (!directory) return null;
  for (const relative of ['Contents/Resources/app/package.json', 'resources/app/package.json']) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, relative), 'utf8'));
      if (typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version)) return manifest.version;
    } catch { /* try the next layout */ }
  }
  return null;
}

function cursorVersionFor(home, plat = platform, environment = process.env) {
  return cursorVersionFrom(cursorDirFor(home, plat, environment));
}

function magpieExecutableFor(home, plat = platform, environment = process.env) {
  const p = join(plat);
  if (plat === 'darwin') return '/Applications/magpie.app/Contents/MacOS/magpie';
  if (plat === 'win32') {
    const local = environment.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    for (const candidate of [p.join(local, 'Programs', 'magpie', 'magpie.exe'), p.join(local, 'magpie', 'magpie.exe')]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return executable('magpie', {plat, environment});
  }
  return findExecutable([
    p.join(home, '.local', 'bin', 'magpie'),
    '/usr/local/bin/magpie',
    '/usr/bin/magpie',
    '/opt/magpie/magpie',
    'magpie'
  ], {plat, environment});
}

// Returns the argv prefix that prints a process command line, or null when
// the platform has no supported probe.
function processCommandFor(pid, {plat = platform, environment = process.env} = {}) {
  if (plat === 'win32') {
    const powershell = findExecutable(['powershell', 'pwsh'], {plat, environment});
    if (!powershell) return null;
    return {
      command: powershell,
      args: ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`]
    };
  }
  const ps = findExecutable(['/bin/ps', '/usr/bin/ps', 'ps'], {plat, environment});
  if (!ps) return null;
  return {command: ps, args: ['-p', String(pid), '-o', 'command=']};
}

function openCommandFor(target, {plat = platform, environment = process.env} = {}) {
  if (plat === 'win32') return {command: 'explorer.exe', args: [target]};
  if (plat === 'linux') {
    const opener = findExecutable(['xdg-open', 'gio'], {plat, environment});
    if (!opener) return null;
    return opener.endsWith('gio') ? {command: opener, args: ['open', target]} : {command: opener, args: [target]};
  }
  const opener = findExecutable(['/usr/bin/open', 'open'], {plat, environment});
  return opener ? {command: opener, args: [target]} : null;
}

// `systemctl --user` is the service owner on Linux. The probe only answers
// whether the binary exists; whether the user manager is reachable is decided
// by actually running it, because a container can ship systemctl without a
// running user instance.
function systemctlFor({plat = platform, environment = process.env} = {}) {
  if (plat !== 'linux') return null;
  return findExecutable(['/usr/bin/systemctl', '/bin/systemctl', 'systemctl'], {plat, environment});
}

function sqlite3For({plat = platform, environment = process.env} = {}) {
  if (plat === 'win32') return findExecutable(['sqlite3'], {plat, environment});
  return findExecutable(['/usr/bin/sqlite3', '/usr/local/bin/sqlite3', '/opt/homebrew/bin/sqlite3', 'sqlite3'], {plat, environment});
}

const serviceSupported = IS_DARWIN || IS_WIN || IS_LINUX;

// The legacy Magpie plugin's LaunchAgent label. The VSIX is not a service and
// never installs one, but it must be able to *detect* the legacy background
// bridge: two owners writing Cursor's proxy at once produce 502s.
const legacyServiceName = 'local.magpie.cursor-bridge';

// The native engine ships per platform and architecture. macOS arm64 used to
// live at bin/cursor-magpie-bridge; inside the VSIX every platform has its own
// folder, which also keeps per-platform packaging deterministic.
function enginePathFor(source, plat = platform, arch = process.arch) {
  const p = join(plat);
  const exe = plat === 'win32' ? 'cursor-magpie-bridge.exe' : 'cursor-magpie-bridge';
  const folder = `${plat}-${arch}`;
  return p.join(source, 'resources', 'bin', folder, exe);
}

const current = {
  platform,
  serviceName: legacyServiceName,
  enginePath: (source) => enginePathFor(source),
  connectionFiles: (home = os.homedir()) => connectionFilesFor(home),
  cursorSettings: (home = os.homedir()) => cursorSettingsFor(home),
  cursorArgv: (home = os.homedir()) => cursorArgvFor(home),
  nssDatabase: (home = os.homedir()) => nssDatabaseFor(home),
  cursorDir: (home = os.homedir()) => cursorDirFor(home),
  cursorVersion: (home = os.homedir()) => cursorVersionFor(home),
  magpieExecutable: (home = os.homedir()) => magpieExecutableFor(home),
  processCommand: (pid) => processCommandFor(pid),
  openCommand: (target) => openCommandFor(target),
  systemctl: () => systemctlFor(),
  sqlite3: () => sqlite3For(),
  serviceSupported
};

module.exports = {
  platform,
  IS_DARWIN,
  IS_WIN,
  IS_LINUX,
  serviceSupported,
  serviceName: legacyServiceName,
  enginePathFor,
  findExecutable,
  connectionFilesFor,
  cursorSettingsFor,
  cursorArgvFor,
  nssDatabaseFor,
  cursorDirFor,
  cursorVersionFrom,
  cursorVersionFor,
  magpieExecutableFor,
  processCommandFor,
  openCommandFor,
  systemctlFor,
  sqlite3For,
  current
};