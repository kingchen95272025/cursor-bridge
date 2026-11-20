'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toAnthropicRequest,
  toOpenAIResponse,
  toOpenAIError,
  AnthropicStreamTranslator,
  anthropicEndpoint,
  anthropicModelsEndpoint,
  mapStopReason
} = require('../src/anthropic.js');

test('请求转换：system 合并、工具调用、工具结果合并与参数', () => {
  const request = toAnthropicRequest({
    messages: [
      {role: 'system', content: 'You are helpful'},
      {role: 'system', content: 'Be terse'},
      {role: 'user', content: [{type: 'text', text: 'list files'}]},
      {role: 'assistant', content: null, tool_calls: [
        {id: 'call_1', type: 'function', function: {name: 'ls', arguments: '{"path":"."}'}}
      ]},
      {role: 'tool', tool_call_id: 'call_1', content: '["a","b"]'},
      {role: 'tool', tool_call_id: 'call_2', content: 'second'}
    ],
    tools: [{type: 'function', function: {name: 'ls', description: 'list', parameters: {type: 'object', properties: {path: {type: 'string'}}}}}],
    tool_choice: 'auto',
    max_tokens: 100,
    temperature: 0.2,
    stop: ['END']
  }, 'claude-x');

  assert.equal(request.model, 'claude-x');
  assert.equal(request.system, 'You are helpful\n\nBe terse');
  assert.equal(request.max_tokens, 100);
  assert.equal(request.temperature, 0.2);
  assert.deepEqual(request.stop_sequences, ['END']);
  const assistant = request.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.content[0].type, 'tool_use');
  assert.equal(assistant.content[0].id, 'call_1');
  assert.deepEqual(assistant.content[0].input, {path: '.'});
  const tail = request.messages[request.messages.length - 1];
  assert.equal(tail.role, 'user');
  assert.equal(tail.content.length, 2);
  assert.equal(tail.content[0].type, 'tool_result');
  assert.equal(tail.content[1].tool_use_id, 'call_2');
  assert.equal(request.tools[0].input_schema.properties.path.type, 'string');
  assert.deepEqual(request.tool_choice, {type: 'auto'});
});

test('请求转换：默认 max_tokens、tool_choice 变体与图片', () => {
  assert.equal(toAnthropicRequest({messages: []}, 'm').max_tokens, 8192);
  assert.deepEqual(toAnthropicRequest({messages: [], tools: [{function: {name: 'x'}}], tool_choice: 'required'}, 'm').tool_choice, {type: 'any'});
  assert.deepEqual(toAnthropicRequest({messages: [], tools: [{function: {name: 'x'}}], tool_choice: {function: {name: 'x'}}}, 'm').tool_choice, {type: 'tool', name: 'x'});
  const image = toAnthropicRequest({
    messages: [{role: 'user', content: [
      {type: 'text', text: 'see'},
      {type: 'image_url', image_url: {url: 'data:image/png;base64,AAA'}},
      {type: 'image_url', image_url: {url: 'https://x/y.png'}}
    ]}]
  }, 'm');
  assert.equal(image.messages[0].content[1].source.media_type, 'image/png');
  assert.equal(image.messages[0].content[2].source.type, 'url');
});

test('非流式响应转换：文本、工具调用、usage 与结束原因', () => {
  const response = toOpenAIResponse({
    id: 'msg_1',
    content: [{type: 'text', text: 'hello'}, {type: 'tool_use', id: 'toolu_1', name: 'ls', input: {path: '.'}}],
    stop_reason: 'tool_use',
    usage: {input_tokens: 10, output_tokens: 5}
  }, 'cc/claude-x');
  assert.equal(response.model, 'cc/claude-x');
  assert.equal(response.choices[0].message.content, 'hello');
  assert.equal(response.choices[0].message.tool_calls[0].id, 'toolu_1');
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{"path":"."}');
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(response.usage, {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15});
  assert.equal(mapStopReason('max_tokens'), 'length');
  assert.equal(mapStopReason('end_turn'), 'stop');
});

test('流式转换：文本、工具参数、结束帧与 usage，支持跨块边界', () => {
  const translator = new AnthropicStreamTranslator({model: 'cc/claude-x'});
  const output = [];
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"ls","input":{}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\".\\"}"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ];
  // Feed the stream in awkward pieces: event boundaries and JSON must be
  // reassembled from the buffer.
  for (const event of events) {
    const middle = Math.floor(event.length / 2);
    output.push(translator.push(event.slice(0, middle)));
    output.push(translator.push(event.slice(middle)));
  }
  const text = output.join('');
  assert.match(text, /"role":"assistant"/);
  assert.match(text, /"content":"Hel"/);
  assert.match(text, /"name":"ls"/);
  assert.match(text, /"finish_reason":"tool_calls"/);
  assert.match(text, /"prompt_tokens":7/);
  assert.match(text, /"completion_tokens":3/);
  assert.match(text, /data: \[DONE\]/);
  assert.equal(translator.finish(), '');
});

test('端点与错误映射', () => {
  assert.equal(anthropicEndpoint('https://api.x.com'), 'https://api.x.com/v1/messages');
  assert.equal(anthropicEndpoint('https://api.x.com/anthropic'), 'https://api.x.com/anthropic/v1/messages');
  assert.equal(anthropicEndpoint('https://api.x.com/v1'), 'https://api.x.com/v1/messages');
  assert.equal(anthropicModelsEndpoint('https://api.x.com/anthropic'), 'https://api.x.com/anthropic/v1/models');
  assert.deepEqual(toOpenAIError({type: 'error', error: {type: 'rate_limit_error', message: 'slow down'}}, 429), {
    error: {message: 'slow down', type: 'rate_limit_error', code: 429}
  });
});