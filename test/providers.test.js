'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {extractModels, normalizeModel, readMagpieConnection, resolve, fetchModels, refreshProvider} = require('../src/providers.js');
const {tempHomeWithCcSwitch} = require('./fixtures/cc-switch-store.js');

test('模型列表兼容 data / models / 数组三种响应', () => {
  assert.deepEqual(extractModels({data: [{id: 'a'}, {id: 'b', context_window: 128000}]}).map((model) => model.id), ['a', 'b']);
  assert.deepEqual(extractModels({models: [{name: 'c'}]}).map((model) => model.id), ['c']);
  assert.deepEqual(extractModels([{model: 'd'}]).map((model) => model.id), ['d']);
  assert.deepEqual(extractModels({data: [{id: 'a'}, {id: 'a'}]}).length, 1);
});

test('模型字段归一化', () => {
  assert.deepEqual(normalizeModel({id: 'm', name: 'M', context_length: 64000}), {id: 'm', name: 'M', context: 64000});
  assert.deepEqual(normalizeModel('plain'), {id: 'plain', name: 'plain', context: null});
  assert.equal(normalizeModel({id: ''}), null);
});

test('Magpie 连接发现要求 enabled 且包含网关与密钥', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-home-'));
  const dir = path.join(home, '.config', 'magpie-cursor-bridge');
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'connection.json');
  fs.writeFileSync(file, JSON.stringify({
    enabled: true,
    gateway: 'http://127.0.0.1:3425/v1',
    key: 'magpie-key',
    model: 'p/b',
    models: [{id: 'p/a', name: 'A', context: 1000}, {id: 'p/b'}]
  }));
  const connection = readMagpieConnection(home);
  assert.equal(connection.gateway, 'http://127.0.0.1:3425/v1');
  assert.equal(connection.models.length, 2);
  assert.equal(connection.model, 'p/b');

  fs.writeFileSync(file, JSON.stringify({enabled: false, gateway: 'http://127.0.0.1:3425/v1', key: 'k'}));
  assert.equal(readMagpieConnection(home), null);
});

test('Provider 解析：Magpie 自动发现与自定义密钥', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-home-'));
  const dir = path.join(home, '.config', 'magpie-cursor-bridge');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'connection.json'), JSON.stringify({
    enabled: true, gateway: 'http://127.0.0.1:3425/v1', key: 'magpie-key', model: 'm', models: [{id: 'm'}]
  }));
  const resolved = resolve([
    {id: 'magpie', type: 'magpie', name: 'Magpie', enabled: true, autoDiscover: true, baseUrl: '', headers: {}, models: []},
    {id: 'custom', type: 'openai', name: 'Custom', enabled: true, autoDiscover: false, baseUrl: 'https://api.example/v1', headers: {}, models: ['x']}
  ], {custom: 'sk-test'}, home);
  assert.equal(resolved.providers.length, 2);
  assert.equal(resolved.providers[0].key, 'magpie-key');
  assert.equal(resolved.providers[1].key, 'sk-test');
  assert.deepEqual(resolved.providers[1].knownModels, [{id: 'x', name: 'x', context: null}]);
});

test('自动发现缺失时给出可操作的问题描述', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-home-'));
  const resolved = resolve([
    {id: 'magpie', type: 'magpie', name: 'Magpie', enabled: true, autoDiscover: true, baseUrl: '', headers: {}, models: []}
  ], {}, home);
  assert.equal(resolved.providers.length, 0);
  assert.match(resolved.problems[0].message, /Magpie/);
});

test('cc-switch 实时 provider 使用 Anthropic 协议与原始网关地址', () => {
  const home = tempHomeWithCcSwitch();
  const configProviders = [{
    id: 'ccswitch', type: 'cc-switch', name: 'cc-switch', enabled: true,
    autoDiscover: true, baseUrl: '', headers: {}, models: []
  }];
  const resolved = resolve(configProviders, {}, home, {ccSwitchCache: {}});
  assert.equal(resolved.providers.length, 1);
  const provider = resolved.providers[0];
  assert.equal(provider.type, 'cc-switch');
  assert.equal(provider.protocol, 'anthropic');
  assert.equal(provider.key, 'sk-test-token');
  assert.match(provider.name, /cc-switch · DeepSeek/);
  assert.equal(provider.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.ok(provider.ccSwitch.candidates.includes('https://api.deepseek.com/v1'));
  assert.deepEqual(provider.knownModels.map((model) => model.id), ['deepseek-chat']);
});

test('cc-switch 无可用供应商时给出问题而不是空 provider', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-bridge-no-ccswitch-'));
  const resolved = resolve([{
    id: 'ccswitch', type: 'cc-switch', name: 'cc-switch', enabled: true,
    autoDiscover: true, baseUrl: '', headers: {}, models: []
  }], {}, home, {ccSwitchCache: {}});
  assert.equal(resolved.providers.length, 0);
  assert.match(resolved.problems[0].message, /cc-switch/);
});

test('cc-switch 刷新在 Anthropic 模型端点缺失时保留 cc-switch 模型名', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, {'content-type': 'application/json'});
    res.end('{"error":{"message":"not found"}}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const provider = {
    id: 'ccswitch', type: 'cc-switch', protocol: 'anthropic', name: 'cc-switch', baseUrl: base,
    key: 'k', headers: {}, knownModels: [{id: 'claude-x', name: 'claude-x', context: null}],
    ccSwitch: {key: 'k1', candidates: []}
  };
  const result = await refreshProvider(provider, null, {});
  assert.equal(result.error, null);
  assert.deepEqual(result.models.map((model) => model.id), ['claude-x']);
  assert.match(result.warning, /404/);
});

test('Anthropic 模型端点可用时以远端列表为准', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({data: [{id: 'fresh-model', display_name: 'Fresh'}]}));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const provider = {
    id: 'x', type: 'openai', protocol: 'anthropic', name: 'X', baseUrl: base,
    key: 'k', headers: {}, knownModels: []
  };
  const result = await refreshProvider(provider);
  assert.equal(result.error, null);
  assert.equal(result.models[0].id, 'fresh-model');
});

test('拉取模型与失败时保留旧目录', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({data: [{id: 'live-1', context_window: 32000}]}));
      return;
    }
    res.writeHead(500);
    res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const provider = {id: 'p', name: 'P', baseUrl, key: 'k', headers: {}, knownModels: []};
  const models = await fetchModels(provider);
  assert.equal(models[0].id, 'live-1');
  assert.equal(models[0].context, 32000);

  const previous = {provider, models: [{id: 'last-good', name: 'Last', context: null}], error: null};
  const failed = await refreshProvider({...provider, baseUrl: 'http://127.0.0.1:1/v1'}, previous);
  assert.equal(failed.error !== null, true);
  assert.deepEqual(failed.models.map((model) => model.id), ['last-good']);
});