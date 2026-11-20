'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

// A VSIX can look complete (vsce prints a file count) while missing a runtime
// dependency that .vscodeignore silently excluded. This check unpacks the
// package and loads the modules the extension actually needs, which is how the
// missing vendor/jsonc-parser was caught before publishing.

const REQUIRED = [
  'extension.js',
  'package.json',
  'src/service.js',
  'src/shim.js',
  'src/webview.js',
  'lib/settings.js',
  'lib/platform.js',
  'vendor/jsonc-parser/lib/umd/main.js',
  'media/console.html',
  'media/console.css',
  'media/console.js'
];

// vsce lowercases documentation names and turns LICENSE into LICENSE.txt.
const REQUIRED_DOCS = ['readme.md', 'changelog.md', 'license'];

function verify(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-verify-'));
  try {
    const unzip = spawnSync('unzip', ['-q', '-o', file, '-d', dir], {encoding: 'utf8'});
    if (unzip.status !== 0) throw new Error(`解压失败：${unzip.stderr || unzip.stdout}`);
    const root = path.join(dir, 'extension');
    const problems = [];
    for (const name of REQUIRED) {
      if (!fs.existsSync(path.join(root, name))) problems.push(`缺少 ${name}`);
    }
    const topLevel = fs.readdirSync(root).map((name) => name.toLowerCase());
    for (const doc of REQUIRED_DOCS) {
      const present = topLevel.some((name) => name === doc || name === `${doc}.txt`);
      if (!present) problems.push(`缺少 ${doc}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.main?.replace(/^\.\//, '') !== 'extension.js') problems.push('package.json 的 main 不是 extension.js');

    const bins = fs.existsSync(path.join(root, 'resources', 'bin'))
      ? fs.readdirSync(path.join(root, 'resources', 'bin'))
      : [];
    if (bins.length !== 1) problems.push(`resources/bin 应只含一个平台，实际 ${bins.join('、') || '空'}`);
    for (const platform of bins) {
      const dirPath = path.join(root, 'resources', 'bin', platform);
      const entries = fs.readdirSync(dirPath);
      if (!entries.length) problems.push(`${platform} 下没有引擎`);
      for (const entry of entries) {
        const stat = fs.statSync(path.join(dirPath, entry));
        if (process.platform !== 'win32' && !(stat.mode & 0o111)) problems.push(`${platform}/${entry} 没有可执行权限`);
      }
    }

    // Load every shipped module in a child process so a missing require is a
    // hard failure instead of a runtime surprise after installation.
    const probe = spawnSync(process.execPath, ['-e', [
      "require('./lib/settings.js');",
      "require('./lib/platform.js');",
      "require('./src/config.js');",
      "require('./src/catalogue.js');",
      "require('./src/providers.js');",
      "require('./src/shim.js');",
      "require('./src/engine.js');",
      "require('./src/certificates.js');",
      "require('./src/database.js');",
      "require('./src/service.js');",
      "console.log('modules-ok');"
    ].join('')], {cwd: root, encoding: 'utf8', timeout: 30000});
    if (probe.status !== 0 || !probe.stdout.includes('modules-ok')) {
      problems.push(`模块加载失败：${(probe.stderr || probe.stdout || '').split('\n').slice(0, 4).join(' ')}`);
    }

    return {file: path.basename(file), ok: problems.length === 0, problems, size: fs.statSync(file).size};
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

function main() {
  const dir = path.join(__dirname, '..', 'dist');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith('.vsix')).sort()
    : [];
  if (!files.length) throw new Error('dist/ 中没有 VSIX，请先打包');
  let failed = 0;
  for (const name of files) {
    const result = verify(path.join(dir, name));
    const size = `${(result.size / 1024 / 1024).toFixed(1)} MiB`;
    if (result.ok) console.log(`✔ ${result.file} (${size})`);
    else {
      failed += 1;
      console.log(`✘ ${result.file} (${size})`);
      for (const problem of result.problems) console.log(`    ${problem}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} 个包未通过校验`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}