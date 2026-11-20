'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const platform = require('../lib/platform.js');

// The VSIX does not replace the legacy Magpie plugin: both own Cursor's
// http.proxy and both spawn an engine. Two owners fight over the journal and
// produce 502s that look like provider failures. Detection is therefore a
// first-class startup step, and the console tells the user exactly what to
// stop instead of trying to out-muscle the other service.

function legacyJournal(home) {
  const file = path.join(home, '.config', 'magpie-cursor-bridge', 'settings-journal.json');
  return fs.existsSync(file) ? file : null;
}

function legacyLaunchAgent(home) {
  try {
    const output = execFileSync('/bin/launchctl', ['list'], {encoding: 'utf8', timeout: 5000});
    const active = output.split(/\r?\n/).some((line) => line.includes(platform.serviceName));
    const plist = path.join(home, 'Library', 'LaunchAgents', `${platform.serviceName}.plist`);
    return {active, plist: fs.existsSync(plist) ? plist : null};
  } catch {
    return {active: false, plist: null};
  }
}

function legacySystemd(home) {
  const unit = path.join(home, '.config', 'systemd', 'user', `${platform.serviceName}.service`);
  if (!fs.existsSync(unit)) return {active: false, unit: null};
  let active = false;
  const systemctl = platform.findExecutable(['systemctl']);
  if (systemctl) {
    try {
      execFileSync(systemctl, ['--user', 'is-active', '--quiet', platform.serviceName], {timeout: 5000});
      active = true;
    } catch { /* installed but stopped */ }
  }
  return {active, unit};
}

function legacyStartupEntry(home) {
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const file = path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${platform.serviceName}.vbs`);
  return fs.existsSync(file) ? file : null;
}

function detect({home, settings, expectedProxy}) {
  const items = [];
  const journal = legacyJournal(home);
  if (journal) {
    items.push({
      id: 'legacy-journal',
      title: 'Magpie 后台桥接正在接管代理',
      detail: '发现旧版 Magpie 桥接的 settings-journal.json。两套桥接同时运行会互相改写 Cursor 代理。',
      action: '请在终端运行 `bash setup.command uninstall`（或从 Magpie 插件页卸载旧桥接），然后重启 Cursor。'
    });
  }
  if (platform.IS_DARWIN) {
    const agent = legacyLaunchAgent(home);
    if (agent.active || agent.plist) {
      items.push({
        id: 'legacy-launchagent',
        title: 'Magpie LaunchAgent 仍在注册',
        detail: agent.active ? 'local.magpie.cursor-bridge 正在 launchctl 中运行。' : `发现 ${agent.plist}。`,
        action: '运行 `launchctl bootout gui/$(id -u)/local.magpie.cursor-bridge` 停止后台，必要时删除该 plist。'
      });
    }
  }
  if (platform.IS_LINUX) {
    const unit = legacySystemd(home);
    if (unit.unit) {
      items.push({
        id: 'legacy-systemd',
        title: 'Magpie systemd 用户单元仍在注册',
        detail: unit.active ? 'local.magpie.cursor-bridge.service 正在运行。' : `发现 ${unit.unit}。`,
        action: '运行 `systemctl --user disable --now local.magpie.cursor-bridge` 停止后台。'
      });
    }
  }
  if (platform.IS_WIN) {
    const entry = legacyStartupEntry(home);
    if (entry) {
      items.push({
        id: 'legacy-startup',
        title: 'Magpie 启动项仍在注册',
        detail: `发现启动脚本 ${entry}。`,
        action: '删除该启动脚本并结束 cursor-magpie-bridge 进程。'
      });
    }
  }

  // A proxy that points somewhere else while our journal is absent means
  // another owner is active even if its files were missed above.
  if (expectedProxy && settings && settings.current && settings.current !== expectedProxy && !settings.journaled) {
    items.push({
      id: 'foreign-proxy',
      title: 'Cursor 代理由其他程序设置',
      detail: `当前 http.proxy = ${settings.current}，不是 Cursor Bridge 的地址。`,
      action: '请先确认该代理来源；需要接管时点击「强制接管并重写代理」。'
    });
  }
  return {detected: items.length > 0, items};
}

module.exports = {detect};