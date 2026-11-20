'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {encode, decode, build, pickDefault, applyPrefs} = require('../src/catalogue.js');

test('聚合 ID 用第一个斜杠分隔，模型自身的斜杠保留', () => {
  assert.equal(encode('magpie', 'anthropic/claude-sonnet-4'), 'magpie/anthropic/claude-sonnet-4');
  assert.deepEqual(decode('magpie/anthropic/claude-sonnet-4'), {providerId: 'magpie', upstreamId: 'anthropic/claude-sonnet-4'});
});

test('非法聚合 ID 返回 null', () => {
  assert.equal(decode(''), null);
  assert.equal(decode('no-slash'), null);
  assert.equal(decode('/model'), null);
  assert.equal(decode('UPPER/model'), null);
  assert.equal(decode('provider/'), null);
});

function refreshed(id, name, models, error = null) {
  return {
    provider: {id, name, type: 'openai', baseUrl: 'http://x', key: 'k', headers: {}, knownModels: []},
    models,
    error,
    refreshedAt: 1
  };
}

test('多提供者聚合且重名时追加提供者名', () => {
  const result = build([
    refreshed('a', 'Alpha', [{id: 'x', name: 'Same', context: 1000}]),
    refreshed('b', 'Beta', [{id: 'y', name: 'Same', context: null}])
  ]);
  assert.equal(result.models.length, 2);
  assert.equal(result.models[0].id, 'a/x');
  assert.equal(result.models[0].name, 'Same · Alpha');
  assert.equal(result.models[1].name, 'Same · Beta');
  assert.equal(result.models[1].context, null);
});

test('偏好可隐藏、重命名与排序', () => {
  const models = [
    {id: 'a/1', upstreamId: '1', providerId: 'a', providerName: 'A', name: 'One', context: null},
    {id: 'a/2', upstreamId: '2', providerId: 'a', providerName: 'A', name: 'Two', context: null},
    {id: 'a/3', upstreamId: '3', providerId: 'a', providerName: 'A', name: 'Three', context: null}
  ];
  const result = applyPrefs(models, {names: {'2': '第二'}, hidden: ['3'], order: ['2', '1']});
  assert.deepEqual(result.map((model) => model.upstreamId), ['2', '1']);
  assert.equal(result[0].name, '第二');
});

test('拉取失败但有旧模型时仍出现在目录中', () => {
  const result = build([
    refreshed('a', 'A', [{id: '1', name: 'One', context: null}], 'upstream down'),
    refreshed('b', 'B', [], 'no models')
  ]);
  assert.equal(result.models.length, 1);
  assert.equal(result.groups[0].error, 'upstream down');
  assert.equal(result.groups.length, 1);
});

test('默认模型优先使用已选中的有效 ID', () => {
  const models = [{id: 'a/1'}, {id: 'a/2'}];
  assert.equal(pickDefault(models, 'a/2'), 'a/2');
  assert.equal(pickDefault(models, 'missing'), 'a/1');
  assert.equal(pickDefault([], 'a/1'), null);
});