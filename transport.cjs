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

/** Bridge WS events to Pi's SDK parser; never replay a sent request inside fetch. */
function createWebSocketTransport(WebSocket, { now = Date.now } = {}) {
  const connections = new Set();
  const recovery = new Map();
  const encoder = new TextEncoder();
  const idleLifetimeMs = 60_000;
  const maxConnectionAgeMs = 55 * 60_000;
  let requestSequence = 0;
  let connectionSequence = 0;

  function remove(entry) {
    clearTimeout(entry.expiry);
    connections.delete(entry);
    entry.socket.terminate();
  }

  function fetchFor(options = {}) {
    const websocketFetch = async (input, init, state, report, route) => {
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
      const key = options.reuseConnection === false ? undefined : state.routeKey;
      for (const candidate of connections) {
        if (!candidate.busy && now() - candidate.createdAt >= maxConnectionAgeMs) remove(candidate);
      }
      let entry = key && [...connections].find(item => item.key === key && !item.busy && item.socket.readyState === WebSocket.OPEN);
      const reused = Boolean(entry);
      const useCachedContext = options.cachedContext !== false && (options.transport === 'auto' || options.transport === 'websocket-cached');
      const continuation = entry?.continuation;
      let wireBody = useCachedContext ? incrementalBody(payload, continuation) ?? payload : payload;
      let callIds = wireBody !== payload ? new Map(continuation.callIds) : new Map();
      if (!entry) {
        entry = {
          key, busy: true, expiry: undefined, createdAt: now(), id: ++connectionSequence,
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
      report('connecting', {
        connectionId: entry.id, reused, context: wireBody === payload ? 'full' : 'delta',
        inputItems: wireBody.input?.length ?? 0, fullInputItems: payload.input?.length ?? 0,
      });
      return new Promise((resolve, reject) => {
        let responded = false;
        let finished = false;
        let controller;
        let timer;
        let responseStarted = false;
        let recoveredContinuation = false;
        const stream = new ReadableStream({
          start(value) { controller = value; },
          cancel() { finish(new Error('WebSocket response consumption cancelled.'), false, 'cancelled'); },
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
        function finish(failure, reusable = true, errorKind = 'protocol', details = {}) {
          if (finished) return;
          finished = true;
          cleanup();
          if (failure) {
            report(errorKind === 'cancelled' ? 'cancelled' : 'failed', { errorKind, ...details });
            if (['connection', 'closed', 'idle_timeout'].includes(errorKind) && !request.signal.aborted && route) {
              route.failures++;
              const threshold = options.fallbackAfterFailures ?? 2;
              if (options.transport === 'auto' && threshold > 0 && route.failures >= threshold) {
                route.sse = true;
                for (const candidate of connections) if (candidate.key === key && !candidate.busy) remove(candidate);
                report('fallback_pending', { failures: route.failures });
              }
            }
            // Before fetch resolves, reject only; do not leave an unobserved errored stream.
            if (responded) controller.error(failure);
            else reject(failure);
            remove(entry);
          } else {
            controller.close();
            entry.busy = false;
            if (route) route.failures = 0;
            report(reusable ? 'completed' : 'failed', reusable ? {} : { errorKind: 'server' });
            if (reusable && key && !route?.sse && socket.readyState === WebSocket.OPEN && now() - entry.createdAt < maxConnectionAgeMs) {
              entry.expiry = setTimeout(() => remove(entry), Math.min(idleLifetimeMs, maxConnectionAgeMs - (now() - entry.createdAt)));
              entry.expiry.unref();
            } else remove(entry);
          }
        }
        function touch() {
          clearTimeout(timer);
          const timeoutMs = options.timeoutMs ?? 300_000;
          if (timeoutMs > 0) timer = setTimeout(() => finish(new Error('network error: Toolkit WebSocket response idle timeout.'), false, 'idle_timeout'), timeoutMs);
        }
        function abort() { finish(request.signal.reason || new DOMException('Aborted', 'AbortError'), false, 'cancelled'); }
        function error(cause) {
          // Never expose the underlying message, URL, headers or server body.
          const configurationCodes = ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'];
          const protocolCodes = ['WS_ERR_INVALID_OPCODE', 'WS_ERR_INVALID_UTF8', 'WS_ERR_INVALID_CLOSE_CODE', 'WS_ERR_UNEXPECTED_RSV_1', 'WS_ERR_UNEXPECTED_RSV_2_3', 'WS_ERR_EXPECTED_MASK', 'WS_ERR_UNEXPECTED_MASK', 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'];
          const errorKind = configurationCodes.includes(cause?.code) ? 'configuration' : protocolCodes.includes(cause?.code) ? 'protocol' : 'connection';
          const errorCode = [...configurationCodes, ...protocolCodes, 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH'].includes(cause?.code) ? cause.code : undefined;
          finish(new Error(`${errorKind === 'connection' ? 'network error: ' : ''}Toolkit WebSocket connection failed.${errorCode ? ` (${errorCode})` : ''}`), false, errorKind, errorCode ? { errorCode } : {});
        }
        function closed(code) { finish(new Error(`network error: Toolkit WebSocket closed before response completion (code ${code}).`), false, 'closed', { closeCode: code }); }
        function unexpected(_request, response) {
          // Preserve HTTP status and retry headers without copying/logging server bodies.
          responded = true;
          finished = true;
          cleanup();
          response.resume();
          controller.close();
          if (route) route.failures = 0;
          report('failed', { errorKind: 'http', httpStatus: response.statusCode });
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
          if (finished || request.signal.aborted) return;
          report('waiting', { requestSent: true });
          try { socket.send(JSON.stringify(wireBody), failure => { if (failure) error(failure); }); }
          catch (failure) { error(failure); }
        }
        function message(data) {
          if (finished) return;
          touch();
          let event;
          try { event = JSON.parse(data.toString()); }
          catch { return finish(new Error('Invalid JSON in Toolkit WebSocket response.')); }
          if (!event || typeof event.type !== 'string') return finish(new Error('Invalid Toolkit WebSocket event.'));
          const progress = /^response\.(output_text|reasoning.*|function_call_arguments|custom_tool_call_input)\.delta$/.test(event.type) && typeof event.delta === 'string' && event.delta.length > 0;
          report('streaming', { lastEventAt: now(), ...(progress ? { lastProgressAt: now() } : {}) });
          const code = event.code ?? event.error?.code;
          if (event.type === 'error' && code === 'previous_response_not_found' && wireBody !== payload && !responseStarted && !recoveredContinuation) {
            // The server rejected the continuation before starting a response.
            // Replay the complete request once on WS; never retry quota or other errors.
            recoveredContinuation = true;
            report('streaming', { context: 'full', inputItems: payload.input?.length ?? 0 });
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
      request.signal.throwIfAborted();
      const body = JSON.parse(await request.clone().text());
      const identityHeaders = new Headers(request.headers);
      for (const name of ['x-client-request-id', 'content-length', 'content-type', 'accept-encoding', 'connection', 'host']) identityHeaders.delete(name);
      const routeKey = options.sessionId ? createHash('sha256').update(JSON.stringify([
        options.sessionId, request.url, body.model, [...identityHeaders.entries()],
      ])).digest('hex') : undefined;
      let route = routeKey && recovery.get(routeKey);
      if (routeKey && !route) { route = { failures: 0, sse: false }; recovery.set(routeKey, route); }
      const state = { requestId: ++requestSequence, routeKey, startedAt: now(), transport: 'websocket', requestSent: false };
      function report(phase, patch = {}) {
        Object.assign(state, patch, { phase });
        // This private key never leaves the transport, even in optional observers.
        const { routeKey: _key, ...publicState } = state;
        try { options.onTransportState?.({ ...publicState }); } catch { /* UI must not affect transport. */ }
      }
      async function http(request, reason) {
        request.signal.throwIfAborted();
        report('connecting', { transport: 'sse', reason, requestSent: true, lastEventAt: undefined, lastProgressAt: undefined,
          errorKind: undefined, errorCode: undefined, closeCode: undefined, httpStatus: undefined,
          connectionId: undefined, reused: false, context: 'full', inputItems: body.input?.length ?? 0, fullInputItems: body.input?.length ?? 0 });
        try {
          const response = await httpFetch(request);
          report(response.ok ? 'waiting' : 'failed', { httpStatus: response.status, ...(response.ok ? {} : { errorKind: 'http' }) });
          return response;
        } catch (failure) {
          report(request.signal.aborted ? 'cancelled' : 'failed', { errorKind: request.signal.aborted ? 'cancelled' : 'http' });
          throw failure;
        }
      }
      if (options.transport === 'sse') return http(request, 'explicit');
      if (options.transport === 'auto' && route?.sse) return http(request, 'sticky_fallback');
      const fallback = options.transport === 'auto' ? request.clone() : undefined;
      let response;
      try {
        response = await websocketFetch(request, undefined, state, report, route);
      } catch (failure) {
        // After opening, errors only reach the reader. Pi owns the next logical attempt.
        if (!fallback || request.signal.aborted || !failure.message.startsWith('network error:') || !/WebSocket (connection failed|closed before response completion)/.test(failure.message)) throw failure;
        return http(fallback, 'handshake_network');
      }
      if (fallback && [400, 404, 405, 426, 501].includes(response.status)) {
        await response.body?.cancel();
        request.signal.throwIfAborted();
        if (route && (options.fallbackAfterFailures ?? 2) > 0) route.sse = true;
        return http(fallback, 'unsupported_upgrade');
      }
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
  return { fetchFor, rememberResponse, close() { for (const entry of [...connections]) remove(entry); recovery.clear(); } };
}
module.exports = { createWebSocketTransport };
