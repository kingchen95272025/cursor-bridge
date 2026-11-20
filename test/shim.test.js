'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {createShim} = require('../src/shim.js');

function upstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      requests.push({method: req.method, url: req.url, headers: req.headers, body});
      if (req.url === '/v1/models') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({data: [{id: 'm1'}, {id: 'm2'}]}));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        if (body.stream) {
          res.writeHead(200, {'content-type': 'text/event-stream'});
          res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
          res.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, {'content-type': 'application/json'});
          res.end(JSON.stringify({choices: [{message: {content: 'hi'}}], usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5}}));
        }
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({server, requests, port: server.address().port}));
  });
}

function providersFor(port) {
  return new Map([['p', {
    id: 'p',
    name: 'Provider',
    type: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    key: 'up-key',
    headers: {'x-extra': 'yes'},
    knownModels: []
  }]]);
}

test('shim 鉴权、模型目录与 Chat 透传', async (t) => {
  const upstreamInfo = await upstream();
  const calls = [];
  const shim = createShim({
    token: 'local-token',
    getProviders: () => providersFor(upstreamInfo.port),
    getCatalogue: () => ({
      models: [
        {id: 'p/m1', name: 'M1', context: 1000, providerId: 'p', upstreamId: 'm1'},
        {id: 'p/m2', name: 'M2', context: null, providerId: 'p', upstreamId: 'm2'}
      ],
      groups: []
    }),
    onCall: (entry) => calls.push(entry)
  });
  const info = await shim.start(0);
  t.after(async () => { await shim.stop(); upstreamInfo.server.close(); });

  const unauthorized = await fetch(`${info.baseUrl}/models`);
  assert.equal(unauthorized.status, 401);

  const models = await fetch(`${info.baseUrl}/models`, {headers: {Authorization: 'Bearer local-token'}});
  assert.equal(models.status, 200);
  const catalogue = await models.json();
  assert.deepEqual(catalogue.data.map((model) => model.id), ['p/m1', 'p/m2']);

  const response = await fetch(`${info.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {Authorization: 'Bearer local-token', 'content-type': 'application/json'},
    body: JSON.stringify({model: 'p/m1', messages: [{role: 'user', content: 'hi'}]})
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'hi');

  const forwarded = upstreamInfo.requests.find((request) => request.url === '/v1/chat/completions');
  assert.equal(forwarded.body.model, 'm1');
  assert.equal(forwarded.headers.authorization, 'Bearer up-key');
  assert.equal(forwarded.headers['x-extra'], 'yes');

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, 200);
  assert.equal(calls[0].inputTokens, 3);
  assert.equal(calls[0].outputTokens, 2);
  assert.equal(calls[0].model, 'p/m1');
});

test('shim 流式转发并解析 usage', async (t) => {
  const upstreamInfo = await upstream();
  const calls = [];
  const shim = createShim({
    token: 't',
    getProviders: () => providersFor(upstreamInfo.port),
    getCatalogue: () => ({models: [{id: 'p/m1', providerId: 'p', upstreamId: 'm1', name: 'M1', context: null}], groups: []}),
    onCall: (entry) => calls.push(entry)
  });
  const info = await shim.start(0);
  t.after(async () => { await shim.stop(); upstreamInfo.server.close(); });

  const response = await fetch(`${info.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {Authorization: 'Bearer t', 'content-type': 'application/json', accept: 'text/event-stream'},
    body: JSON.stringify({model: 'p/m1', stream: true, messages: []})
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /\[DONE\]/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].totalTokens, 5);
  assert.ok(calls[0].ttfbMs !== null);
});

test('shim 把 Anthropic 上游的流式响应翻译成 OpenAI SSE', async (t) => {
  const calls = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(req.url, '/anthropic/v1/messages');
      assert.equal(req.headers['x-api-key'], 'anth-key');
      assert.equal(req.headers['anthropic-version'], '2023-06-01');
      assert.equal(body.model, 'claude-real');
      assert.equal(body.messages[0].content, 'hi');
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\n\n');
      res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}/anthropic`;
  const shim = createShim({
    token: 'local',
    getProviders: () => new Map([['cc', {
      id: 'cc', name: 'CC', type: 'cc-switch', protocol: 'anthropic',
      baseUrl: base, key: 'anth-key', headers: {}, knownModels: []
    }]]),
    getCatalogue: () => ({
      models: [{id: 'cc/claude-real', providerId: 'cc', upstreamId: 'claude-real', name: 'X', context: null}],
      groups: []
    }),
    onCall: (entry) => calls.push(entry)
  });
  const info = await shim.start(0);
  t.after(() => shim.stop());
  const response = await fetch(`${info.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {Authorization: 'Bearer local', 'content-type': 'application/json'},
    body: JSON.stringify({model: 'cc/claude-real', stream: true, messages: [{role: 'user', content: 'hi'}]})
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /"content":"ok"/);
  assert.match(text, /data: \[DONE\]/);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].inputTokens, 2);
  assert.equal(calls[0].outputTokens, 1);
});

test('未知模型与无效 Base URL 返回明确错误', async (t) => {
  const shim = createShim({
    token: 't',
    getProviders: () => new Map(),
    getCatalogue: () => ({models: [], groups: []})
  });
  const info = await shim.start(0);
  t.after(() => shim.stop());
  const response = await fetch(`${info.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {Authorization: 'Bearer t', 'content-type': 'application/json'},
    body: JSON.stringify({model: 'ghost/model', messages: []})
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.error.message, /unknown model/);
});