'use strict';
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

function parametersOf(body) {
  const { input, previous_response_id, ...parameters } = body;
  return parameters;
}

function incrementalBody(body, continuation) {
  if (!continuation?.replayItems || !Array.isArray(body.input) || body.previous_response_id) return;
  if (!isDeepStrictEqual(parametersOf(body), parametersOf(continuation.body))) return;
  const baseline = [...continuation.body.input, ...continuation.replayItems];
  if (body.input.length < baseline.length || !isDeepStrictEqual(body.input.slice(0, baseline.length), baseline)) return;
  const delta = body.input.slice(baseline.length).map(item => {
    if (!['function_call_output', 'custom_tool_call_output'].includes(item.type)) return item;
    return { ...item, call_id: continuation.callIds.get(item.call_id) ?? item.call_id };
  });
  return { ...body, previous_response_id: continuation.id, input: delta };
}

/** Bridge WS events to Pi's SDK parser; auto may fall back only before sending. */
function createWebSocketTransport(WebSocket) {
  const connections = new Set();
  const encoder = new TextEncoder();
  const idleLifetimeMs = 60_000;

  function remove(entry) {
    clearTimeout(entry.expiry);
    connections.delete(entry);
    entry.socket.terminate();
  }

  function fetchFor(options = {}) {
    const websocketFetch = async (input, init) => {
      const request = new Request(input, init);
      request.signal.throwIfAborted();
      const url = new URL(request.url);
      if (request.method !== 'POST' || !url.pathname.endsWith('/responses')) {
        throw new Error('Toolkit WS transport only accepts POST /responses requests.');
      }
      const payload = JSON.parse(await request.text());
      delete payload.stream;
      delete payload.background;
      payload.type = 'response.create';
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const headers = Object.fromEntries(request.headers);
      for (const name of ['content-length', 'content-type', 'accept-encoding', 'connection', 'host']) delete headers[name];
      headers.accept = 'application/json';
      // Hash authentication and routing headers rather than keeping keys in map keys.
      const identity = createHash('sha256').update(JSON.stringify(headers)).digest('hex');
      const key = options.sessionId ? `${options.sessionId}:${url}:${identity}` : undefined;
      let entry = key && [...connections].find(item => item.key === key && !item.busy && item.socket.readyState === WebSocket.OPEN);
      const reused = Boolean(entry);
      const useCachedContext = options.cachedContext !== false && (options.transport === 'auto' || options.transport === 'websocket-cached');
      const continuation = entry?.continuation;
      let wireBody = useCachedContext ? incrementalBody(payload, continuation) ?? payload : payload;
      let callIds = wireBody !== payload ? new Map(continuation.callIds) : new Map();
      if (!entry) {
        entry = {
          key, busy: true, expiry: undefined,
          socket: new WebSocket(url, {
            headers, followRedirects: false,
            handshakeTimeout: options.websocketConnectTimeoutMs ?? 15_000,
          }),
        };
        connections.add(entry);
        // Per-request listeners below handle active failures; idle failures just evict.
        entry.socket.on('error', () => { if (!entry.busy) remove(entry); });
        entry.socket.on('close', () => { clearTimeout(entry.expiry); connections.delete(entry); });
      }
      entry.busy = true;
      entry.continuation = undefined;
      clearTimeout(entry.expiry);
      const socket = entry.socket;
      return new Promise((resolve, reject) => {
        let responded = false;
        let finished = false;
        let controller;
        let timer;
        let responseStarted = false;
        let recoveredContinuation = false;
        const stream = new ReadableStream({
          start(value) { controller = value; },
          cancel() { finish(new Error('WebSocket response consumption cancelled.')); },
        });
        function cleanup() {
          clearTimeout(timer);
          request.signal.removeEventListener('abort', abort);
          socket.off('open', open);
          socket.off('message', message);
          socket.off('error', error);
          socket.off('close', closed);
          socket.off('unexpected-response', unexpected);
        }
        function finish(failure, reusable = true) {
          if (finished) return;
          finished = true;
          cleanup();
          if (failure) {
            // Before fetch resolves, reject only; do not leave an unobserved errored stream.
            if (responded) controller.error(failure);
            else reject(failure);
            remove(entry);
          } else {
            controller.close();
            entry.busy = false;
            if (reusable && key && socket.readyState === WebSocket.OPEN) {
              entry.expiry = setTimeout(() => remove(entry), idleLifetimeMs);
              entry.expiry.unref();
            } else remove(entry);
          }
        }
        function touch() {
          clearTimeout(timer);
          const timeoutMs = options.timeoutMs ?? 300_000;
          if (timeoutMs > 0) timer = setTimeout(() => finish(new Error('Toolkit WebSocket response idle timeout.')), timeoutMs);
        }
        function abort() { finish(request.signal.reason || new DOMException('Aborted', 'AbortError')); }
        function error() { finish(new Error('Toolkit WebSocket connection failed.')); }
        function closed(code) { finish(new Error(`Toolkit WebSocket closed before response completion (code ${code}).`)); }
        function unexpected(_request, response) {
          // Preserve HTTP status and retry headers without copying/logging server bodies.
          responded = true;
          finished = true;
          cleanup();
          response.resume();
          controller.close();
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') responseHeaders.set(name, value);
          }
          responseHeaders.delete('content-encoding');
          responseHeaders.delete('content-length');
          responseHeaders.set('content-type', 'application/json');
          resolve(new Response(JSON.stringify({ error: { message: `Toolkit WebSocket handshake rejected (HTTP ${response.statusCode}).` } }), {
            status: response.statusCode, headers: responseHeaders,
          }));
          remove(entry);
        }
        function open() {
          if (finished) return;
          if (request.signal.aborted) return abort();
          touch();
          // Response cannot represent HTTP 101. Expose WS identity on the synthetic
          // 200 response; the SDK's existing onResponse hook still runs before parsing.
          responded = true;
          resolve(new Response(stream, { headers: {
            'content-type': 'text/event-stream',
            'x-pi-transport': 'websocket',
            'x-pi-websocket-status': '101',
            'x-pi-websocket-reused': String(reused),
            'x-pi-websocket-context': wireBody === payload ? 'full' : 'delta',
            'x-pi-websocket-input-items': String(wireBody.input?.length ?? 0),
            'x-pi-websocket-full-input-items': String(payload.input?.length ?? 0),
          } }));
          send();
        }
        function send() {
          socket.send(JSON.stringify(wireBody), failure => { if (failure) error(); });
        }
        function message(data) {
          if (finished) return;
          touch();
          let event;
          try { event = JSON.parse(data.toString()); }
          catch { return finish(new Error('Invalid JSON in Toolkit WebSocket response.')); }
          if (!event || typeof event.type !== 'string') return finish(new Error('Invalid Toolkit WebSocket event.'));
          const code = event.code ?? event.error?.code;
          if (event.type === 'error' && code === 'previous_response_not_found' && wireBody !== payload && !responseStarted && !recoveredContinuation) {
            // The server rejected the continuation before starting a response.
            // Replay the complete request once on WS; never retry quota or other errors.
            recoveredContinuation = true;
            wireBody = payload;
            callIds = new Map();
            send();
            return;
          }
          if (event.type.startsWith('response.')) responseStarted = true;
          if (event.type === 'response.completed' && useCachedContext && key && event.response?.status === 'completed' && event.response.id && !payload.previous_response_id && Array.isArray(payload.input) && Array.isArray(event.response.output)) {
            entry.continuation = {
              id: event.response.id, owner: options.cacheOwner, body: payload, output: event.response.output, callIds,
            };
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type)) {
            finish(undefined, event.type === 'response.completed');
          }
        }
        socket.on('open', open);
        socket.on('message', message);
        socket.on('error', error);
        socket.on('close', closed);
        socket.on('unexpected-response', unexpected);
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
        else if (socket.readyState === WebSocket.OPEN) open();
      });
    };
    const httpFetch = options.fetch ?? globalThis.fetch;
    return async (input, init) => {
      const request = new Request(input, init);
      if (options.transport === 'sse') return httpFetch(request);
      const fallback = options.transport === 'auto' ? request.clone() : undefined;
      let response;
      try {
        response = await websocketFetch(request);
      } catch (failure) {
        // websocketFetch rejects only before the handshake resolves. After opening,
        // failures go to the reader and must never replay a possibly billed request.
        if (!fallback || request.signal.aborted || !/WebSocket (connection failed|closed before response completion)/.test(failure.message)) throw failure;
        return httpFetch(fallback);
      }
      if (fallback && [400, 404, 405, 426, 501].includes(response.status)) {
        await response.body?.cancel();
        request.signal.throwIfAborted();
        return httpFetch(fallback);
      }
      // Authentication, quota and server errors remain visible to Pi's retry policy.
      return response;
    };
  }
  function rememberResponse(id, replayItems, owner) {
    for (const entry of connections) {
      const continuation = entry.continuation;
      if (entry.busy || !continuation?.output || continuation.id !== id || continuation.owner !== owner) continue;
      // Use Pi's exact next-turn representation, not raw response.output:
      // custom provider tool IDs and JSON arguments can change during conversion.
      const replay = JSON.parse(JSON.stringify(replayItems));
      const isCall = item => ['function_call', 'custom_tool_call'].includes(item.type);
      const rawCalls = continuation.output.filter(isCall);
      const replayCalls = replay.filter(isCall);
      if (rawCalls.length !== replayCalls.length) { entry.continuation = undefined; continue; }
      for (let i = 0; i < rawCalls.length; i++) {
        if (rawCalls[i].type !== replayCalls[i].type || rawCalls[i].name !== replayCalls[i].name || !rawCalls[i].call_id || !replayCalls[i].call_id) {
          entry.continuation = undefined;
          break;
        }
        const existing = continuation.callIds.get(replayCalls[i].call_id);
        if (existing && existing !== rawCalls[i].call_id) {
          entry.continuation = undefined;
          break;
        }
        continuation.callIds.set(replayCalls[i].call_id, rawCalls[i].call_id);
      }
      if (entry.continuation) {
        continuation.replayItems = replay;
        delete continuation.output;
      }
    }
  }
  return { fetchFor, rememberResponse, close() { for (const entry of [...connections]) remove(entry); } };
}
module.exports = { createWebSocketTransport };
