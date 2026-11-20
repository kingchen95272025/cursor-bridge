'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

// vsce has no way to include only one platform's binary from a multi-platform
// tree, so every package is built from a staging copy that contains exactly
// one resources/bin folder. That also keeps the VSIX around 16 MB instead of
// shipping 265 MB of engines to every user.

const REPO = path.resolve(__dirname, '..');
const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64'];
const RUNTIME_FILES = [
  'package.json',
  'extension.js',
  'src',
  'lib',
  'vendor',
  'media',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  '.vscodeignore'
];

function copy(target, source) {
  fs.cpSync(source, target, {recursive: true, force: true, preserveTimestamps: true});
}

function stagingDir(target) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cursor-bridge-${target}-`));
  for (const name of RUNTIME_FILES) {
    const source = path.join(REPO, name);
    if (!fs.existsSync(source)) continue;
    copy(path.join(dir, name), source);
  }
  const binSource = path.join(REPO, 'resources', 'bin', target);
  if (!fs.existsSync(binSource)) throw new Error(`缺少原生引擎：resources/bin/${target}`);
  fs.mkdirSync(path.join(dir, 'resources', 'bin'), {recursive: true});
  copy(path.join(dir, 'resources', 'bin', target), binSource);
  return dir;
}

function vsceCommand() {
  const local = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
  if (fs.existsSync(local)) return {command: local, prefix: []};
  return {command: 'npx', prefix: ['--yes', '@vscode/vsce']};
}

function packageOne(target, {outDir}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const output = path.join(outDir, `cursor-bridge-${manifest.version}-${target}.vsix`);
  const dir = stagingDir(target);
  try {
    const {command, prefix} = vsceCommand();
    const result = spawnSync(command, [
      ...prefix,
      'package',
      '--target', target,
      '--out', output,
      '--no-dependencies'
    ], {cwd: dir, stdio: 'inherit', env: process.env});
    if (result.status !== 0) throw new Error(`vsce 打包失败（${target}），退出码 ${result.status}`);
    const size = fs.statSync(output).size;
    console.log(`✔ ${path.basename(output)} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
    return output;
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

function main() {
  const requested = process.argv[2] || 'host';
  const targets = requested === 'all'
    ? TARGETS
    : requested === 'host'
      ? [`${process.platform}-${process.arch}`]
      : [requested];
  for (const target of targets) {
    if (!TARGETS.includes(target)) throw new Error(`未知平台 ${target}；可选：${TARGETS.join('、')}`);
  }
  const outDir = path.join(REPO, 'dist');
  fs.mkdirSync(outDir, {recursive: true});
  const outputs = [];
  for (const target of targets) outputs.push(packageOne(target, {outDir}));
  console.log(`\n已生成 ${outputs.length} 个 VSIX：`);
  for (const output of outputs) console.log(`  ${output}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}