'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {scan, load, current, baseCandidates, modelsFromEnv} = require('../src/cc-switch.js');
const {tempHomeWithCcSwitch} = require('./fixtures/cc-switch-store.js');

test('候选地址优先网关根路径，Anthropic 专用路径与附加端点作为后备', () => {
  assert.deepEqual(baseCandidates('https://api.deepseek.com/anthropic'), [
    'https://api.deepseek.com',
    'https://api.deepseek.com/v1',
    'https://api.deepseek.com/anthropic'
  ]);
  assert.deepEqual(baseCandidates('https://zero.cat'), ['https://zero.cat', 'https://zero.cat/v1']);
  assert.deepEqual(baseCandidates('https://api.example.com/v1'), ['https://api.example.com/v1']);
  assert.deepEqual(baseCandidates('https://x.dev/anthropic', ['https://x.dev/openai/v1']), [
    'https://x.dev',
    'https://x.dev/v1',
    'https://x.dev/anthropic',
    'https://x.dev/openai/v1'
  ]);
  assert.deepEqual(baseCandidates('not-a-url'), []);
});

test('模型从 env 的多个键去重提取', () => {
  assert.deepEqual(modelsFromEnv({ANTHROPIC_MODEL: 'a', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'a', CLAUDE_CODE_SUBAGENT_MODEL: 'b'}), ['a', 'b']);
});

test('SQLite 扫描：过滤 app_type、去重、密钥不出现在结果中', () => {
  const home = tempHomeWithCcSwitch();
  const result = scan(home);
  assert.equal(result.source, 'cc-switch.db');
  assert.equal(result.error, null);
  assert.equal(result.providers.length, 2);
  const deepseek = result.providers.find((provider) => provider.name === 'DeepSeek');
  assert.ok(deepseek);
  assert.equal(deepseek.hasToken, true);
  assert.equal(deepseek.token, undefined);
  assert.equal(deepseek.isCurrent, true);
  assert.deepEqual(deepseek.models, ['deepseek-chat']);
  assert.equal(deepseek.candidates[0], 'https://api.deepseek.com');
  assert.ok(deepseek.candidates.includes('https://api.deepseek.com/openai/v1'));
  const noToken = result.providers.find((provider) => provider.name === 'NoToken');
  assert.equal(noToken.hasToken, false);
});

test('SQLite load 返回令牌用于写入 SecretStorage', () => {
  const home = tempHomeWithCcSwitch();
  const entry = scan(home).providers.find((provider) => provider.name === 'DeepSeek');
  const loaded = load(home, entry.key);
  assert.equal(loaded.token, 'sk-test-token');
  assert.equal(loaded.baseUrl, 'https://api.deepseek.com/anthropic');
});

test('current 优先 claude 的当前供应商并携带令牌', () => {
  const home = tempHomeWithCcSwitch();
  const active = current(home);
  assert.equal(active.name, 'DeepSeek');
  assert.equal(active.appType, 'claude');
  assert.equal(active.implicit, false);
  assert.equal(active.token, 'sk-test-token');
  assert.equal(active.candidates[0], 'https://api.deepseek.com');
});

test('旧版 config.json 兼容对象与数组两种 providers 结构', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-ccswitch-json-'));
  fs.mkdirSync(path.join(home, '.cc-switch'), {recursive: true});
  fs.writeFileSync(path.join(home, '.cc-switch', 'config.json'), JSON.stringify({
    version: 2,
    claude: {
      current: 'a',
      providers: [
        {id: 'a', name: 'Alpha', settingsConfig: {env: {
          ANTHROPIC_BASE_URL: 'https://alpha.example/anthropic',
          ANTHROPIC_API_KEY: 'sk-alpha'
        }}},
        {id: 'b', name: 'Beta', settingsConfig: {env: {ANTHROPIC_BASE_URL: 'https://beta.example'}}}
      ]
    }
  }));
  const result = scan(home);
  assert.equal(result.source, 'config.json');
  assert.equal(result.providers.length, 2);
  const alpha = result.providers.find((provider) => provider.name === 'Alpha');
  assert.equal(alpha.isCurrent, true);
  assert.equal(alpha.hasToken, true);
  assert.equal(load(home, alpha.key).token, 'sk-alpha');
  assert.equal(current(home).name, 'Alpha');
});

test('未安装 cc-switch 时给出可读错误', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-empty-'));
  const result = scan(home);
  assert.equal(result.source, null);
  assert.match(result.error, /cc-switch/);
  assert.equal(current(home), null);
});