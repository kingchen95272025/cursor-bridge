'use strict';

// cc-switch providers speak the Anthropic Messages protocol, Cursor's engine
// speaks OpenAI Chat Completions. This module is the translator between them:
// request conversion, streaming event conversion, and non-streaming response
// conversion.
//
// Tool calls are the load-bearing part. Cursor's agent loop only works if
// assistant tool_use blocks come back as OpenAI tool_calls with the same ids
// and the same JSON argument strings, and if OpenAI tool results go back as
// Anthropic tool_result blocks.

const DEFAULT_MAX_TOKENS = 8192;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return part.text || '';
    return '';
  }).join('');
}

function imagePart(part) {
  if (part?.type !== 'image_url') return null;
  const url = String(part.image_url?.url || '');
  if (url.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (!match) return null;
    return {type: 'image', source: {type: 'base64', media_type: match[1], data: match[2]}};
  }
  if (/^https?:\/\//i.test(url)) return {type: 'image', source: {type: 'url', url}};
  return null;
}

function contentOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({type: 'text', text: part});
      continue;
    }
    if (part?.type === 'text') {
      parts.push({type: 'text', text: part.text || ''});
      continue;
    }
    const image = imagePart(part);
    if (image) parts.push(image);
  }
  return parts.length ? parts : '';
}

function safeJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

// OpenAI messages -> Anthropic messages + top-level system.
function toAnthropicRequest(body, upstreamModel) {
  const system = [];
  const messages = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = message?.role;
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content);
      if (text) system.push(text);
      continue;
    }
    if (role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: String(message.tool_call_id || ''),
        content: textOf(message.content)
      };
      // Consecutive tool results must live in one user message, otherwise
      // Anthropic rejects the conversation shape.
      const previous = messages[messages.length - 1];
      if (previous && previous.role === 'user' && Array.isArray(previous.content)
        && previous.content.every((part) => part.type === 'tool_result')) {
        previous.content.push(block);
      } else {
        messages.push({role: 'user', content: [block]});
      }
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      const text = textOf(message.content);
      if (text) blocks.push({type: 'text', text});
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        blocks.push({
          type: 'tool_use',
          id: String(call.id || `toolu_${blocks.length}`),
          name: String(call.function?.name || ''),
          input: safeJson(call.function?.arguments)
        });
      }
      messages.push({role: 'assistant', content: blocks.length ? blocks : ''});
      continue;
    }
    messages.push({role: 'user', content: contentOf(message.content)});
  }

  const request = {
    model: upstreamModel,
    messages,
    max_tokens: Math.max(1, Number(body.max_tokens) || DEFAULT_MAX_TOKENS),
    stream: !!body.stream
  };
  if (system.length) request.system = system.join('\n\n');
  if (Number.isFinite(Number(body.temperature))) request.temperature = Number(body.temperature);
  if (Number.isFinite(Number(body.top_p))) request.top_p = Number(body.top_p);
  if (body.stop) request.stop_sequences = Array.isArray(body.stop) ? body.stop : [String(body.stop)];
  if (Array.isArray(body.tools) && body.tools.length) {
    request.tools = body.tools
      .map((tool) => ({
        name: String(tool?.function?.name || ''),
        description: tool?.function?.description || undefined,
        input_schema: tool?.function?.parameters || {type: 'object', properties: {}}
      }))
      .filter((tool) => tool.name);
    if (!request.tools.length) delete request.tools;
  }
  if (body.tool_choice && request.tools) {
    const choice = body.tool_choice;
    if (choice === 'auto') request.tool_choice = {type: 'auto'};
    else if (choice === 'required') request.tool_choice = {type: 'any'};
    else if (choice === 'none') request.tool_choice = {type: 'none'};
    else if (choice?.function?.name) request.tool_choice = {type: 'tool', name: choice.function.name};
  }
  return request;
}

function anthropicEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

function anthropicModelsEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

function anthropicHeaders(token, extra = {}) {
  return {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(token ? {'x-api-key': token} : {}),
    ...extra
  };
}

function mapStopReason(reason) {
  switch (reason) {
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool_calls';
    case 'refusal': return 'content_filter';
    case 'stop_sequence':
    case 'end_turn': return 'stop';
    default: return 'stop';
  }
}

function newCompletionId() {
  return `chatcmpl-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// Anthropic SSE -> OpenAI chat.completion.chunk frames. The translator owns
// the event framing; the caller only writes the returned strings.
class AnthropicStreamTranslator {
  constructor({model, id = newCompletionId()} = {}) {
    this.model = model;
    this.id = id;
    this.created = Math.floor(Date.now() / 1000);
    this.buffer = '';
    this.blocks = new Map();
    this.usage = {input_tokens: 0, output_tokens: 0};
    this.finishReason = null;
    this.finishSent = false;
    this.started = false;
  }

  frame(delta, finishReason = null, extra = {}) {
    return `data: ${JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{index: 0, delta, finish_reason: finishReason}],
      ...extra
    })}\n\n`;
  }

  push(text) {
    this.buffer += text;
    let output = '';
    let index;
    while ((index = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      output += this.handleBlock(block);
    }
    return output;
  }

  handleBlock(block) {
    let event = '';
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return '';
    let data;
    try { data = JSON.parse(dataLines.join('\n')); } catch { return ''; }
    const type = data.type || event;

    if (type === 'message_start') {
      this.usage.input_tokens = Number(data.message?.usage?.input_tokens) || 0;
      if (!this.started) {
        this.started = true;
        return this.frame({role: 'assistant', content: ''});
      }
      return '';
    }
    if (type === 'content_block_start') {
      const contentBlock = data.content_block || {};
      this.blocks.set(data.index, contentBlock);
      if (contentBlock.type === 'tool_use') {
        return this.frame({tool_calls: [{
          index: data.index,
          id: contentBlock.id,
          type: 'function',
          function: {name: contentBlock.name, arguments: ''}
        }]});
      }
      return '';
    }
    if (type === 'content_block_delta') {
      const delta = data.delta || {};
      if (delta.type === 'text_delta') return this.frame({content: delta.text || ''});
      if (delta.type === 'input_json_delta') {
        return this.frame({tool_calls: [{index: data.index, function: {arguments: delta.partial_json || ''}}]});
      }
      // thinking_delta is intentionally dropped: the engine has its own
      // reasoning channel and an unknown field is safer than a wrong one.
      return '';
    }
    if (type === 'message_delta') {
      this.usage.output_tokens = Number(data.usage?.output_tokens) || this.usage.output_tokens;
      this.finishReason = mapStopReason(data.delta?.stop_reason);
      return '';
    }
    if (type === 'message_stop') return this.finish();
    if (type === 'error') {
      const message = data.error?.message || 'anthropic stream error';
      return `data: ${JSON.stringify({error: {message, type: 'upstream_error'}})}\n\ndata: [DONE]\n\n`;
    }
    return '';
  }

  finish() {
    if (this.finishSent) return '';
    this.finishSent = true;
    const usage = {
      prompt_tokens: this.usage.input_tokens,
      completion_tokens: this.usage.output_tokens,
      total_tokens: this.usage.input_tokens + this.usage.output_tokens
    };
    return `${this.frame({}, this.finishReason || 'stop', {usage})}data: [DONE]\n\n`;
  }
}

function toOpenAIResponse(message, model) {
  const texts = [];
  const toolCalls = [];
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === 'text') texts.push(block.text || '');
    else if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {name: block.name, arguments: JSON.stringify(block.input || {})}
      });
    }
  }
  const input = Number(message?.usage?.input_tokens) || 0;
  const output = Number(message?.usage?.output_tokens) || 0;
  return {
    id: message?.id || newCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: texts.length ? texts.join('') : null,
        ...(toolCalls.length ? {tool_calls: toolCalls} : {})
      },
      finish_reason: mapStopReason(message?.stop_reason)
    }],
    usage: {prompt_tokens: input, completion_tokens: output, total_tokens: input + output}
  };
}

// Anthropic error bodies look like {type:'error', error:{type,message}}.
// Map them onto OpenAI's shape so the engine and our call log stay consistent.
function toOpenAIError(body, status) {
  const message = body?.error?.message || body?.message || `upstream HTTP ${status}`;
  return {error: {message, type: body?.error?.type || 'upstream_error', code: status}};
}

module.exports = {
  DEFAULT_MAX_TOKENS,
  toAnthropicRequest,
  toOpenAIResponse,
  toOpenAIError,
  AnthropicStreamTranslator,
  anthropicEndpoint,
  anthropicModelsEndpoint,
  anthropicHeaders,
  mapStopReason,
  textOf,
  contentOf
};