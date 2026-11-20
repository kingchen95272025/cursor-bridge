'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {extractModels, normalizeModel, readMagpieConnection, resolve, fetchModels, refreshProvider} = require('../src/providers.js');

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