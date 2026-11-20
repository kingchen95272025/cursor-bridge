'use strict';
const http = require('node:http');
const https = require('node:https');
const {decode} = require('./catalogue.js');
const {
  toAnthropicRequest,
  toOpenAIResponse,
  toOpenAIError,
  AnthropicStreamTranslator,
  anthropicEndpoint,
  anthropicHeaders
} = require('./anthropic.js');

// The native engine refuses any gateway that is not loopback. This shim is
// that loopback: it speaks the OpenAI wire format to the engine and forwards
// each request to the provider encoded in the model id. Magpie and remote
// platforms take the exact same path, which is what makes "Magpie is just one
// provider" true instead of a slogan.
//
// The shim is also the only place that sees every call, so it records usage
// without depending on the engine's SQLite schema.

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const HEADER_TIMEOUT_MS = 120000;
const IDLE_TIMEOUT_MS = 300000;

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(Object.assign(new Error('request body too large'), {statusCode: 413}));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req, token) {
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  return bearer === token || apiKey === token;
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  });
  res.end(text);
}

// Streaming responses carry usage in SSE payloads. Scanning line by line and
// only parsing frames that mention `usage` keeps the hot path cheap even when
// a tool call argument is hundreds of kilobytes.
class UsageScanner {
  constructor() {
    this.buffer = '';
    this.usage = null;
  }

  push(chunk) {
    this.buffer += chunk.toString('utf8');
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.scan(line);
    }
    if (this.buffer.length > 1024 * 1024) this.buffer = this.buffer.slice(-4096);
  }

  scan(line) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]' || !payload.includes('"usage"')) return;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && parsed.usage) this.usage = parsed.usage;
    } catch { /* partial or non-JSON frame */ }
  }

  finish(rest = '') {
    if (rest) this.push(rest);
    if (this.buffer) this.scan(this.buffer);
    return this.usage;
  }
}

function usageNumbers(usage) {
  if (!usage || typeof usage !== 'object') return {};
  return {
    inputTokens: Number(usage.prompt_tokens) || 0,
    outputTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0
  };
}

function createShim({token, getProviders, getCatalogue, onCall = () => {}, log = () => {}}) {
  const server = http.createServer(async (req, res) => {
    if (!authorized(req, token)) {
      json(res, 401, {error: {message: 'invalid bridge token', type: 'unauthorized'}});
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
      json(res, 200, {ok: true, service: 'cursor-bridge-shim'});
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      const {models} = getCatalogue();
      json(res, 200, {
        object: 'list',
        data: models.map((model) => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: model.providerId,
          name: model.name,
          context_window: model.context || undefined
        }))
      });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/v1/models/')) {
      const id = pathname.slice('/v1/models/'.length);
      const model = getCatalogue().models.find((entry) => entry.id === id);
      if (!model) {
        json(res, 404, {error: {message: `unknown model ${id}`, type: 'not_found'}});
        return;
      }
      json(res, 200, {
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: model.providerId,
        name: model.name,
        context_window: model.context || undefined
      });
      return;
    }

    const isChat = req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/v1/completions');
    if (!isChat) {
      json(res, 404, {error: {message: `unsupported route ${req.method} ${pathname}`, type: 'not_found'}});
      return;
    }

    let body;
    try {
      const raw = await collectBody(req);
      body = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      json(res, error.statusCode || 400, {error: {message: String(error.message || error), type: 'invalid_request'}});
      return;
    }

    const aggregatedId = String(body.model || '');
    const route = decode(aggregatedId);
    const provider = route ? getProviders().get(route.providerId) : null;
    if (!route || !provider) {
      json(res, 404, {error: {message: `unknown model ${aggregatedId}`, type: 'not_found'}});
      return;
    }

    forward({
      req,
      res,
      provider,
      pathname: pathname === '/v1/completions' ? '/completions' : '/chat/completions',
      aggregatedId,
      upstreamModel: route.upstreamId,
      body,
      onCall,
      log
    });
  });

  // Anthropic-protocol upstreams (cc-switch providers, Claude-compatible
  // gateways) take a separate path: the request and every response frame are
  // translated so the engine keeps seeing OpenAI.
  function forwardAnthropic({req, res, provider, aggregatedId, upstreamModel, body, onCall, log}) {
    const started = Date.now();
    let firstByteAt = null;
    let status = 0;
    let settled = false;
    let usage = {input_tokens: 0, output_tokens: 0};
    let upstreamResponse = null;
    let destroyTimer = null;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (destroyTimer) clearTimeout(destroyTimer);
      const input = Number(usage.input_tokens) || 0;
      const output = Number(usage.output_tokens) || 0;
      onCall({
        ts: started,
        providerId: provider.id,
        providerName: provider.name,
        model: aggregatedId,
        upstreamModel,
        status,
        durationMs: Date.now() - started,
        ttfbMs: firstByteAt ? firstByteAt - started : null,
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        error: error ? String(error.message || error) : null
      });
      if (error) log(`proxy error ${provider.id}/${upstreamModel}: ${error.message || error}`);
    };

    let target;
    try {
      target = new URL(anthropicEndpoint(provider.baseUrl));
    } catch (error) {
      status = 502;
      json(res, 502, {error: {message: `invalid provider base URL: ${error.message}`, type: 'bad_gateway'}});
      finish(error);
      return;
    }

    const payload = Buffer.from(JSON.stringify(toAnthropicRequest(body, upstreamModel)));
    const headers = {
      ...anthropicHeaders(provider.key, provider.headers),
      'content-length': payload.length,
      'user-agent': 'cursor-bridge/0.1'
    };
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers
    });

    function resetIdle() {
      if (destroyTimer) clearTimeout(destroyTimer);
      destroyTimer = setTimeout(() => {
        request.destroy(new Error(`upstream stream idle for ${IDLE_TIMEOUT_MS / 1000}s`));
      }, IDLE_TIMEOUT_MS);
    }

    const timeout = setTimeout(() => {
      request.destroy(new Error(`upstream did not respond within ${HEADER_TIMEOUT_MS / 1000}s`));
    }, HEADER_TIMEOUT_MS);

    request.on('response', (response) => {
      clearTimeout(timeout);
      upstreamResponse = response;
      status = response.statusCode || 502;
      firstByteAt = Date.now();

      if (status >= 400) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* html or empty */ }
          const text = JSON.stringify(toOpenAIError(parsed, status));
          res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text)});
          res.end(text);
          finish(new Error(`upstream HTTP ${status}`));
        });
        response.on('error', (error) => { res.destroy(); finish(error); });
        return;
      }

      if (body.stream) {
        const translator = new AnthropicStreamTranslator({model: aggregatedId});
        res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store'});
        response.on('data', (chunk) => {
          resetIdle();
          const converted = translator.push(chunk.toString('utf8'));
          if (converted && !res.write(converted)) response.pause();
        });
        res.on('drain', () => response.resume());
        response.on('end', () => {
          const tail = translator.finish();
          if (tail) res.write(tail);
          usage = translator.usage;
          res.end();
          finish(null);
        });
        response.on('error', (error) => { res.destroy(); finish(error); });
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => { resetIdle(); chunks.push(chunk); });
      response.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          const text = JSON.stringify({error: {message: `invalid upstream response: ${error.message}`, type: 'bad_gateway'}});
          res.writeHead(502, {'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text)});
          res.end(text);
          finish(error);
          return;
        }
        usage = parsed.usage || {};
        const text = JSON.stringify(toOpenAIResponse(parsed, aggregatedId));
        res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text)});
        res.end(text);
        finish(null);
      });
      response.on('error', (error) => { res.destroy(); finish(error); });
    });

    request.on('error', (error) => {
      clearTimeout(timeout);
      if (destroyTimer) clearTimeout(destroyTimer);
      if (!res.headersSent) {
        status = 502;
        json(res, 502, {error: {message: `upstream ${provider.id} unreachable: ${error.message}`, type: 'bad_gateway'}});
      } else {
        res.destroy();
      }
      finish(error);
    });

    res.on('close', () => {
      if (!settled && !res.writableEnded) {
        request.destroy();
        if (upstreamResponse) upstreamResponse.destroy();
        finish(new Error('client closed the stream'));
      }
    });

    request.end(payload);
  }

  function forward({req, res, provider, pathname, aggregatedId, upstreamModel, body, onCall, log}) {
    if (provider.protocol === 'anthropic') {
      return forwardAnthropic({req, res, provider, aggregatedId, upstreamModel, body, onCall, log});
    }
    const started = Date.now();
    let firstByteAt = null;
    let status = 0;
    let settled = false;
    let upstreamResponse = null;
    let destroyTimer = null;
    const scanner = new UsageScanner();

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (destroyTimer) clearTimeout(destroyTimer);
      const usage = usageNumbers(scanner.usage);
      onCall({
        ts: started,
        providerId: provider.id,
        providerName: provider.name,
        model: aggregatedId,
        upstreamModel,
        status,
        durationMs: Date.now() - started,
        ttfbMs: firstByteAt ? firstByteAt - started : null,
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        totalTokens: usage.totalTokens || 0,
        error: error ? String(error.message || error) : null
      });
      if (error) log(`proxy error ${provider.id}/${upstreamModel}: ${error.message || error}`);
    };

    let target;
    try {
      target = new URL(provider.baseUrl.replace(/\/+$/, '') + pathname);
    } catch (error) {
      status = 502;
      json(res, 502, {error: {message: `invalid provider base URL: ${error.message}`, type: 'bad_gateway'}});
      finish(error);
      return;
    }

    const payload = {...body, model: upstreamModel};
    const serialized = Buffer.from(JSON.stringify(payload));
    const headers = {
      'content-type': 'application/json',
      accept: String(req.headers.accept || 'application/json'),
      'content-length': serialized.length,
      'user-agent': 'cursor-bridge/0.1',
      ...provider.headers
    };
    if (provider.key) headers.authorization = `Bearer ${provider.key}`;

    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers
    });

    const timeout = setTimeout(() => {
      request.destroy(new Error(`upstream did not respond within ${HEADER_TIMEOUT_MS / 1000}s`));
    }, HEADER_TIMEOUT_MS);

    request.on('response', (response) => {
      clearTimeout(timeout);
      upstreamResponse = response;
      status = response.statusCode || 502;
      firstByteAt = Date.now();
      const outgoing = {
        'content-type': response.headers['content-type'] || 'application/json',
        'cache-control': 'no-store'
      };
      if (response.headers['x-request-id']) outgoing['x-request-id'] = response.headers['x-request-id'];
      res.writeHead(status, outgoing);

      const isStream = String(response.headers['content-type'] || '').includes('text/event-stream');
      if (isStream) {
        response.on('data', (chunk) => {
          resetIdle();
          scanner.push(chunk);
          if (!res.write(chunk)) response.pause();
        });
        res.on('drain', () => response.resume());
      } else {
        const chunks = [];
        response.on('data', (chunk) => { resetIdle(); chunks.push(chunk); });
        response.on('end', () => {
          const raw = Buffer.concat(chunks);
          try {
            const parsed = JSON.parse(raw.toString('utf8'));
            if (parsed && parsed.usage) scanner.usage = parsed.usage;
          } catch { /* non-JSON error page */ }
          res.end(raw);
          finish(status >= 400 ? new Error(`upstream HTTP ${status}`) : null);
        });
      }

      response.on('end', () => {
        if (isStream) {
          scanner.finish();
          res.end();
          finish(status >= 400 ? new Error(`upstream HTTP ${status}`) : null);
        }
      });
      response.on('error', (error) => {
        res.destroy();
        finish(error);
      });
    });

    function resetIdle() {
      if (destroyTimer) clearTimeout(destroyTimer);
      destroyTimer = setTimeout(() => {
        request.destroy(new Error(`upstream stream idle for ${IDLE_TIMEOUT_MS / 1000}s`));
      }, IDLE_TIMEOUT_MS);
    }

    request.on('error', (error) => {
      clearTimeout(timeout);
      if (destroyTimer) clearTimeout(destroyTimer);
      if (!res.headersSent) {
        status = 502;
        json(res, 502, {error: {message: `upstream ${provider.id} unreachable: ${error.message}`, type: 'bad_gateway'}});
      } else {
        res.destroy();
      }
      finish(error);
    });

    res.on('close', () => {
      if (!settled && !res.writableEnded) {
        // Cursor cancelled the run: stop the upstream request instead of
        // paying for tokens nobody will read.
        request.destroy();
        if (upstreamResponse) upstreamResponse.destroy();
        finish(new Error('client closed the stream'));
      }
    });

    request.end(serialized);
  }

  let listening = null;
  function start(port = 0) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        listening = server.address();
        resolve({port: listening.port, baseUrl: `http://127.0.0.1:${listening.port}/v1`});
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!listening) return resolve();
      listening = null;
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return {start, stop, server};
}

module.exports = {createShim, UsageScanner, MAX_REQUEST_BYTES};