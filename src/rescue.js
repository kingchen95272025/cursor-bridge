'use strict';
const fs = require('node:fs');
const path = require('node:path');
const platform = require('../lib/platform.js');

// "Keep the proxy after the window closes" is what makes the bridge feel
// native, but it has one failure mode: the extension gets disabled or
// uninstalled while the proxy still points at a port nobody listens on.
// The rescue script is the escape hatch. It restores the exact settings.json
// backup taken before the first write, so it needs no parser and no Node.
//
// The script lives in a short, memorable directory (~/.cursor-bridge) instead
// of the extension's deep globalStorage path, because the user runs it from a
// terminal while Cursor has no network access.

function rescueDir(home) {
  return path.join(home, '.cursor-bridge');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function backupSettings(settingsFile, backupsDir) {
  fs.mkdirSync(backupsDir, {recursive: true, mode: 0o700});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupsDir, `settings-${stamp}.json`);
  try {
    fs.copyFileSync(settingsFile, target);
    fs.chmodSync(target, 0o600);
  } catch {
    return null;
  }
  // Keep the newest three backups: enough to undo a mistaken apply, small
  // enough that a long-lived install never grows without bound.
  try {
    const files = fs.readdirSync(backupsDir).filter((name) => name.startsWith('settings-') && name.endsWith('.json')).sort().reverse();
    for (const stale of files.slice(3)) {
      try { fs.unlinkSync(path.join(backupsDir, stale)); } catch { /* keep going */ }
    }
  } catch { /* no directory */ }
  return target;
}

function writeScripts({home, settingsFile, backupFile, journalFile, proxyUrl}) {
  const dir = rescueDir(home);
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const written = [];

  if (platform.IS_WIN) {
    const file = path.join(dir, 'restore.ps1');
    const text = [
      '# Cursor Bridge 应急还原：把 Cursor 代理设置恢复到接管前的状态。',
      `$settings = ${powershellQuote(settingsFile)}`,
      `$backup = ${powershellQuote(backupFile || '')}`,
      `$journal = ${powershellQuote(journalFile)}`,
      `if ($backup -and (Test-Path $backup)) { Copy-Item -Force $backup $settings; Write-Host '已还原 Cursor settings.json' } else { Write-Host '未找到备份；请在 Cursor 设置中手动删除 http.proxy' }`,
      `if (Test-Path $journal) { Remove-Item -Force $journal }`,
      `Write-Host '已清除 Cursor Bridge 代理记录，请重启 Cursor。'`
    ].join('\n');
    fs.writeFileSync(file, `${text}\n`, {mode: 0o700});
    written.push(file);
  } else {
    const file = path.join(dir, platform.IS_DARWIN ? 'restore.command' : 'restore.sh');
    const text = [
      '#!/bin/bash',
      '# Cursor Bridge 应急还原：把 Cursor 代理设置恢复到接管前的状态。',
      'set -u',
      `SETTINGS=${shellQuote(settingsFile)}`,
      `BACKUP=${shellQuote(backupFile || '')}`,
      `JOURNAL=${shellQuote(journalFile)}`,
      'if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then',
      '  cp "$BACKUP" "$SETTINGS"',
      '  echo "已还原 Cursor settings.json"',
      'else',
      '  echo "未找到备份；请在 Cursor 设置中手动删除 http.proxy"',
      'fi',
      'rm -f "$JOURNAL"',
      'echo "已清除 Cursor Bridge 代理记录，请重启 Cursor。"'
    ].join('\n');
    fs.writeFileSync(file, `${text}\n`, {mode: 0o700});
    try { fs.chmodSync(file, 0o700); } catch { /* best effort */ }
    written.push(file);
  }

  // A tiny README next to the script: someone reaching this folder is already
  // in a bad state and should not have to guess which file to run.
  const readme = path.join(dir, 'README.txt');
  fs.writeFileSync(readme, [
    'Cursor Bridge 应急还原',
    '',
    `当前接管地址：${proxyUrl || '（未应用）'}`,
    `Cursor 设置：${settingsFile}`,
    `代理记录：${journalFile}`,
    '',
    platform.IS_WIN ? '双击或在 PowerShell 中运行 restore.ps1。' : `运行：bash ${written[0]}`,
    '完成后重启 Cursor。',
    ''
  ].join('\n'), {mode: 0o600});
  written.push(readme);
  return {dir, files: written};
}

module.exports = {rescueDir, backupSettings, writeScripts};