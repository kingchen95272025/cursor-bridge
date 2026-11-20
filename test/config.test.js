'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {normalize, normalizeProvider} = require('../src/config.js');

test('Provider ID 与 URL 校验', () => {
  assert.equal(normalizeProvider({id: 'bad id', baseUrl: 'https://x/v1'}), null);
  assert.equal(normalizeProvider({id: 'ok', baseUrl: 'ftp://x'}), null);
  assert.equal(normalizeProvider({id: 'ok', baseUrl: 'https://user:pass@x/v1'}), null);
  const provider = normalizeProvider({id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1/'});
  assert.equal(provider.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(provider.type, 'openai');
  assert.equal(provider.enabled, true);
});

test('Magpie Provider 默认 loopback 网关且自动发现', () => {
  const provider = normalizeProvider({id: 'magpie', type: 'magpie'});
  assert.equal(provider.baseUrl, 'http://127.0.0.1:3425/v1');
  assert.equal(provider.autoDiscover, true);
});

test('重复与非法 Provider 被过滤，偏好只保留已知提供者', () => {
  const config = normalize({
    providers: [
      {id: 'a', baseUrl: 'https://a/v1'},
      {id: 'a', baseUrl: 'https://duplicate/v1'},
      {id: 'Bad ID', baseUrl: 'https://b/v1'}
    ],
    modelPrefs: {
      a: {names: {m: 'M'}, hidden: ['x'], order: ['m']},
      ghost: {names: {m: 'M'}}
    }
  });
  assert.equal(config.providers.length, 1);
  assert.equal(config.providers[0].baseUrl, 'https://a/v1');
  assert.deepEqual(Object.keys(config.modelPrefs), ['a']);
});

test('models 去重并限制数量', () => {
  const provider = normalizeProvider({id: 'a', baseUrl: 'https://a/v1', models: ['x', 'x', ' y ', '']});
  assert.deepEqual(provider.models, ['x', 'y']);
});