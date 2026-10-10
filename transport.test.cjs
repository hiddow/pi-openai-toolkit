'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { createWebSocketTransport } = require('./transport.cjs');

function fixture(options = {}) {
  class Socket extends EventEmitter {
    static OPEN = 1;
    static instances = [];
    readyState = 0;
    sent = [];
    constructor(url, config) {
      super();
      this.url = url;
      this.config = config;
      Socket.instances.push(this);
      if (!options.deferOpen) queueMicrotask(() => this.open());
    }
    open() { this.readyState = 1; this.emit('open'); }
    send(data, callback) { this.sent.push(JSON.parse(data)); callback(); }
    event(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
    terminate() { this.readyState = 3; queueMicrotask(() => this.emit('close', 1006)); }
  }
  const transport = createWebSocketTransport(Socket, options.runtime);
  const fetch = transport.fetchFor({ sessionId: 'test', ...options });
  const request = (signal, patch = {}) => fetch('https://example.test/v1/responses', {
    method: 'POST', headers: { Authorization: 'Bearer test-fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture', input: [], stream: true, store: false, ...patch }), signal,
  });
  return { Socket, transport, request, cacheOwner: options.cacheOwner };
}
const completed = { type: 'response.completed', response: { status: 'completed' } };

test('converts events, removes HTTP fields and reuses an idle session socket', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  const first = await f.request();
  const socket = f.Socket.instances[0];
  assert.equal(String(socket.url), 'wss://example.test/v1/responses');
  assert.equal(socket.config.followRedirects, false);
  assert.equal(socket.sent[0].type, 'response.create');
  assert.equal(socket.sent[0].stream, undefined);
  assert.equal(first.headers.get('x-pi-transport'), 'websocket');
  socket.event({ type: 'response.output_text.delta', delta: 'OK' }); socket.event(completed);
  assert.match(await first.text(), /"delta":"OK"/);
  const second = await f.request(); socket.event(completed); await second.text();
  assert.equal(f.Socket.instances.length, 1);
  assert.equal(socket.sent.length, 2);
});

test('concurrent calls never share a busy socket', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  const [a, b] = await Promise.all([f.request(), f.request()]);
  assert.equal(f.Socket.instances.length, 2);
  for (const socket of f.Socket.instances) socket.event(completed);
  await Promise.all([a.text(), b.text()]);
});

test('abort during handshake rejects and releases the socket', async t => {
  const f = fixture({ deferOpen: true }); t.after(() => f.transport.close());
  const controller = new AbortController();
  const pending = f.request(controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.Socket.instances[0].readyState, 3);
});

test('abort after open errors the reader and does not reuse the socket', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  const controller = new AbortController();
  const response = await f.request(controller.signal);
  controller.abort();
  await assert.rejects(response.text(), { name: 'AbortError' });
  const next = await f.request(); f.Socket.instances[1].event(completed); await next.text();
  assert.equal(f.Socket.instances.length, 2);
});

test('premature close is not treated as successful completion', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  const response = await f.request(); f.Socket.instances[0].terminate();
  await assert.rejects(response.text(), /closed before response completion/);
});

test('malformed events fail and server error events are preserved for the SDK', async t => {
  const f = fixture(); t.after(() => f.transport.close());
  const response = await f.request(); f.Socket.instances[0].emit('message', Buffer.from('{'));
  await assert.rejects(response.text(), /Invalid JSON/);
  const next = await f.request();
  f.Socket.instances[1].event({ type: 'error', error: { code: 'context_length_exceeded', message: 'Context too long' } });
  assert.match(await next.text(), /context_length_exceeded/);
  assert.equal(f.Socket.instances[1].readyState, 3);
});

test('idle timeout errors the response', async t => {
  const f = fixture({ timeoutMs: 10 }); t.after(() => f.transport.close());
  const response = await f.request();
  await assert.rejects(response.text(), /idle timeout/);
});

test('handshake rejection preserves HTTP status and retry headers', async t => {
  const f = fixture({ deferOpen: true }); t.after(() => f.transport.close());
  const pending = f.request();
  await new Promise(resolve => setImmediate(resolve));
  const rejected = Readable.from(['private server body']);
  rejected.statusCode = 429;
  rejected.headers = { 'retry-after': '2', 'content-encoding': 'gzip', 'content-length': '999' };
  f.Socket.instances[0].emit('unexpected-response', {}, rejected);
  const response = await pending;
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '2');
  assert.equal(response.headers.get('content-encoding'), null);
  assert.doesNotMatch(await response.text(), /private server body/);
});

const user = text => ({ role: 'user', content: [{ type: 'input_text', text }] });
const assistant = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }], id: `msg_${text}`, status: 'completed' });
function completeCached(f, socket, id, output, replay = output) {
  socket.event({ type: 'response.completed', response: { status: 'completed', id, output } });
  f.transport.rememberResponse(id, replay, f.cacheOwner);
}

test('auto chains multiple deltas while retaining a full-history baseline', async t => {
  const f = fixture({ transport: 'auto' }); t.after(() => f.transport.close());
  const first = await f.request(undefined, { input: [user('one')] });
  const socket = f.Socket.instances[0];
  completeCached(f, socket, 'resp_1', [assistant('a')]); await first.text();
  const secondInput = [user('one'), assistant('a'), user('two')];
  const second = await f.request(undefined, { input: secondInput });
  assert.equal(second.headers.get('x-pi-websocket-context'), 'delta');
  assert.equal(socket.sent[1].previous_response_id, 'resp_1');
  assert.deepEqual(socket.sent[1].input, [user('two')]);
  completeCached(f, socket, 'resp_2', [assistant('b')]); await second.text();
  const third = await f.request(undefined, { input: [...secondInput, assistant('b'), user('three')] });
  assert.equal(socket.sent[2].previous_response_id, 'resp_2');
  assert.deepEqual(socket.sent[2].input, [user('three')]);
  completeCached(f, socket, 'resp_3', [assistant('c')]); await third.text();
  assert.equal(f.Socket.instances.length, 1);
});

test('cached tool continuation restores raw call IDs without modifying full input', async t => {
  const f = fixture({ transport: 'websocket-cached' }); t.after(() => f.transport.close());
  const first = await f.request(undefined, { input: [user('read')] });
  const socket = f.Socket.instances[0];
  const raw = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{ "path": "/fixture" }' };
  const replay = { type: 'function_call', call_id: 'call_1_fc_1', name: 'read', arguments: '{"path":"/fixture"}' };
  completeCached(f, socket, 'resp_1', [raw], [replay]); await first.text();
  const full = [user('read'), replay, { type: 'function_call_output', call_id: 'call_1_fc_1', output: 'OK' }];
  const second = await f.request(undefined, { input: full });
  assert.equal(socket.sent[1].previous_response_id, 'resp_1');
  assert.deepEqual(socket.sent[1].input, [{ type: 'function_call_output', call_id: 'call_1', output: 'OK' }]);
  assert.equal(full[2].call_id, 'call_1_fc_1');
  completeCached(f, socket, 'resp_2', [assistant('a')]); await second.text();
});

test('plain websocket stays full-history even if response replay is available', async t => {
  const f = fixture({ transport: 'websocket' }); t.after(() => f.transport.close());
  const first = await f.request(undefined, { input: [user('one')] });
  const socket = f.Socket.instances[0];
  completeCached(f, socket, 'resp_1', [assistant('a')]); await first.text();
  const full = [user('one'), assistant('a'), user('two')];
  const second = await f.request(undefined, { input: full });
  assert.equal(socket.sent[1].previous_response_id, undefined);
  assert.deepEqual(socket.sent[1].input, full);
  socket.event(completed); await second.text();
});

test('history edits and parameter changes invalidate the incremental prefix', async t => {
  for (const change of ['branch', 'compaction', 'tools', 'reasoning']) {
    await t.test(change, async t => {
      const f = fixture({ transport: 'auto' }); t.after(() => f.transport.close());
      const first = await f.request(undefined, { input: [user('one')] });
      const socket = f.Socket.instances[0];
      completeCached(f, socket, 'resp_1', [assistant('a')]); await first.text();
      const patch = { input: [user('one'), assistant('a'), user('two')] };
      if (change === 'branch') patch.input[1] = assistant('changed');
      if (change === 'compaction') patch.input = [user('summary'), user('two')];
      if (change === 'tools') patch.tools = [{ type: 'function', name: 'new_tool' }];
      if (change === 'reasoning') patch.reasoning = { effort: 'high' };
      const second = await f.request(undefined, patch);
      assert.equal(socket.sent[1].previous_response_id, undefined);
      assert.deepEqual(socket.sent[1].input, patch.input);
      socket.event(completed); await second.text();
    });
  }
});

test('missing continuation retries full history exactly once before response events', async t => {
  const f = fixture({ transport: 'auto' }); t.after(() => f.transport.close());
  const first = await f.request(undefined, { input: [user('one')] });
  const socket = f.Socket.instances[0];
  completeCached(f, socket, 'resp_1', [assistant('a')]); await first.text();
  const full = [user('one'), assistant('a'), user('two')];
  const second = await f.request(undefined, { input: full });
  socket.event({ type: 'error', error: { code: 'previous_response_not_found' } });
  assert.equal(socket.sent.length, 3);
  assert.equal(socket.sent[2].previous_response_id, undefined);
  assert.deepEqual(socket.sent[2].input, full);
  completeCached(f, socket, 'resp_2', [assistant('b')]);
  assert.doesNotMatch(await second.text(), /previous_response_not_found/);
  const third = await f.request(undefined, { input: [...full, assistant('b'), user('three')] });
  assert.equal(socket.sent[3].previous_response_id, 'resp_2');
  socket.event({ type: 'error', code: 'previous_response_not_found' });
  socket.event({ type: 'error', code: 'previous_response_not_found' });
  assert.equal(socket.sent.length, 5);
  assert.match(await third.text(), /previous_response_not_found/);
});

test('quota errors and continuation errors after response start never replay requests', async t => {
  for (const afterStart of [false, true]) {
    await t.test(afterStart ? 'after response start' : 'quota', async t => {
      const f = fixture({ transport: 'auto' }); t.after(() => f.transport.close());
      const first = await f.request(undefined, { input: [user('one')] });
      const socket = f.Socket.instances[0];
      completeCached(f, socket, 'resp_1', [assistant('a')]); await first.text();
      const second = await f.request(undefined, { input: [user('one'), assistant('a'), user('two')] });
      if (afterStart) socket.event({ type: 'response.created', response: { id: 'new_response' } });
      socket.event({ type: 'error', error: { code: afterStart ? 'previous_response_not_found' : 'rate_limit_exceeded' } });
      assert.equal(socket.sent.length, 2);
      assert.match(await second.text(), /error/);
      assert.equal(socket.readyState, 3);
    });
  }
});

test('closed cached connection resumes full history on a new socket', async t => {
  const f = fixture({ transport: 'auto' }); t.after(() => f.transport.close());
  const first = await f.request(undefined, { input: [user('one')] });
  const socket = f.Socket.instances[0];
  completeCached(f, socket, 'resp_1', [assistant('a')]); await first.text();
  socket.terminate(); await new Promise(resolve => setImmediate(resolve));
  const full = [user('one'), assistant('a'), user('two')];
  const second = await f.request(undefined, { input: full });
  const next = f.Socket.instances[1];
  assert.equal(next.sent[0].previous_response_id, undefined);
  assert.deepEqual(next.sent[0].input, full);
  next.event(completed); await second.text();
});

test('custom tool outputs use the original server call ID in a delta', async t => {
  const f = fixture({ transport: 'auto' }); t.after(() => f.transport.close());
  const first = await f.request(undefined, { input: [user('custom')] });
  const socket = f.Socket.instances[0];
  const raw = { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_custom', name: 'custom', input: 'value' };
  const replay = { type: 'custom_tool_call', call_id: 'call_custom_ctc_1', name: 'custom', input: 'value' };
  completeCached(f, socket, 'resp_1', [raw], [replay]); await first.text();
  const second = await f.request(undefined, { input: [user('custom'), replay, { type: 'custom_tool_call_output', call_id: replay.call_id, output: 'OK' }] });
  assert.equal(socket.sent[1].input[0].call_id, raw.call_id);
  assert.equal(socket.sent[1].previous_response_id, 'resp_1');
  socket.event(completed); await second.text();
});

test('ambiguous replay call IDs disable continuation rather than misrouting results', async t => {
  const f = fixture({ transport: 'auto' }); t.after(() => f.transport.close());
  const first = await f.request(undefined, { input: [user('tools')] });
  const socket = f.Socket.instances[0];
  const calls = ['one', 'two'].map(id => ({ type: 'function_call', call_id: id, name: 'read', arguments: '{}' }));
  const replay = calls.map(item => ({ ...item, call_id: 'same_alias' }));
  completeCached(f, socket, 'resp_1', calls, replay); await first.text();
  const full = [user('tools'), ...replay, user('next')];
  const second = await f.request(undefined, { input: full });
  assert.equal(socket.sent[1].previous_response_id, undefined);
  assert.deepEqual(socket.sent[1].input, full);
  socket.event(completed); await second.text();
});

test('cache replay preparation is restricted to the originating stream', async t => {
  const f = fixture({ transport: 'auto', cacheOwner: Symbol('owner') }); t.after(() => f.transport.close());
  const first = await f.request(undefined, { input: [user('one')] });
  const socket = f.Socket.instances[0];
  socket.event({ type: 'response.completed', response: { status: 'completed', id: 'resp_1', output: [assistant('a')] } });
  f.transport.rememberResponse('resp_1', [assistant('wrong')], Symbol('foreign'));
  f.transport.rememberResponse('resp_1', [assistant('a')], f.cacheOwner);
  await first.text();
  const second = await f.request(undefined, { input: [user('one'), assistant('a'), user('two')] });
  assert.equal(socket.sent[1].previous_response_id, 'resp_1');
  socket.event(completed); await second.text();
});

test('caller-owned previous_response_id is not used as a local full-history baseline', async t => {
  const f = fixture({ transport: 'auto' }); t.after(() => f.transport.close());
  const first = await f.request(undefined, { previous_response_id: 'external', input: [user('one')] });
  const socket = f.Socket.instances[0];
  completeCached(f, socket, 'resp_1', [assistant('a')]); await first.text();
  const second = await f.request(undefined, { input: [user('one'), assistant('a'), user('two')] });
  assert.equal(socket.sent[1].previous_response_id, undefined);
  socket.event(completed); await second.text();
});

function rejectHandshake(socket, status) {
  const response = Readable.from([]);
  response.statusCode = status;
  response.headers = {};
  socket.emit('unexpected-response', {}, response);
}

test('auto falls back to SSE only for unsupported upgrades and preserves the original body', async t => {
  let httpRequest;
  const f = fixture({ transport: 'auto', deferOpen: true, fetch: async request => {
    httpRequest = request;
    return new Response('SSE fallback');
  } }); t.after(() => f.transport.close());
  const pending = f.request(undefined, { input: [user('one')] });
  await new Promise(resolve => setImmediate(resolve));
  rejectHandshake(f.Socket.instances[0], 426);
  assert.equal(await (await pending).text(), 'SSE fallback');
  assert.equal(httpRequest.url, 'https://example.test/v1/responses');
  const body = await httpRequest.json();
  assert.equal(body.stream, true);
  assert.equal(body.type, undefined);
  assert.deepEqual(body.input, [user('one')]);
  assert.equal(f.Socket.instances[0].sent.length, 0);
});

test('auto falls back after a handshake network failure, but never after sending', async t => {
  let calls = 0;
  const f = fixture({ transport: 'auto', deferOpen: true, fetch: async () => { calls++; return new Response('fallback'); } });
  t.after(() => f.transport.close());
  const first = f.request();
  await new Promise(resolve => setImmediate(resolve));
  f.Socket.instances[0].emit('error', new Error('private network diagnostic'));
  assert.equal(await (await first).text(), 'fallback');
  const second = f.request();
  await new Promise(resolve => setImmediate(resolve));
  f.Socket.instances[1].open();
  const response = await second;
  f.Socket.instances[1].terminate();
  await assert.rejects(response.text(), /closed before response completion/);
  assert.equal(calls, 1);
});

test('auto never hides authentication, quota or server handshake errors', async t => {
  for (const status of [401, 403, 429, 500, 503]) await t.test(String(status), async t => {
    const f = fixture({ transport: 'auto', deferOpen: true, fetch: async () => assert.fail('unexpected HTTP fallback') });
    t.after(() => f.transport.close());
    const pending = f.request();
    await new Promise(resolve => setImmediate(resolve));
    rejectHandshake(f.Socket.instances[0], status);
    const response = await pending;
    assert.equal(response.status, status);
    await response.text();
  });
});

test('explicit WS is strict and explicit SSE never creates a socket', async t => {
  const strict = fixture({ transport: 'websocket-cached', deferOpen: true, fetch: async () => assert.fail('unexpected fallback') });
  t.after(() => strict.transport.close());
  const pending = strict.request();
  await new Promise(resolve => setImmediate(resolve));
  rejectHandshake(strict.Socket.instances[0], 426);
  assert.equal((await pending).status, 426);
  const sse = fixture({ transport: 'sse', fetch: async () => new Response('SSE') });
  t.after(() => sse.transport.close());
  assert.equal(await (await sse.request()).text(), 'SSE');
  assert.equal(sse.Socket.instances.length, 0);
});

test('cachedContext false keeps full-history WS even when Pi requests auto caching', async t => {
  const f = fixture({ transport: 'auto', cachedContext: false });
  t.after(() => f.transport.close());
  const first = await f.request(undefined, { input: [user('one')] });
  const socket = f.Socket.instances[0];
  completeCached(f, socket, 'resp_1', [assistant('a')]);
  await first.text();
  const full = [user('one'), assistant('a'), user('two')];
  const second = await f.request(undefined, { input: full });
  assert.equal(socket.sent[1].previous_response_id, undefined);
  assert.deepEqual(socket.sent[1].input, full);
  socket.event(completed);
  await second.text();
});

async function disconnect(f, patch = {}) {
  const response = await f.request(undefined, patch);
  f.Socket.instances.at(-1).terminate();
  await assert.rejects(response.text(), /network error:.*closed before response completion/);
}

test('two WS disconnects switch only the next auto attempt to SSE and stay there', async t => {
  const states = [];
  const httpBodies = [];
  const f = fixture({ transport: 'auto', onTransportState: state => states.push(state), fetch: async request => {
    httpBodies.push(await request.json()); return new Response('HTTP OK');
  } }); t.after(() => f.transport.close());
  await disconnect(f, { input: [user('private prompt')] });
  await disconnect(f, { input: [user('private prompt')] });
  assert.equal(httpBodies.length, 0, 'never replay a sent request within fetch');
  assert.ok(states.some(state => state.phase === 'fallback_pending'));
  const input = [user('full next context')];
  assert.equal(await (await f.request(undefined, { input })).text(), 'HTTP OK');
  assert.equal(await (await f.request()).text(), 'HTTP OK');
  assert.equal(f.Socket.instances.length, 2);
  assert.equal(httpBodies[0].stream, true);
  assert.deepEqual(httpBodies[0].input, input);
  assert.equal(httpBodies[0].previous_response_id, undefined);
  assert.doesNotMatch(JSON.stringify(states), /private prompt|Bearer|example\.test|routeKey/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.request(cancelled.signal), { name: 'AbortError' });
  assert.equal(httpBodies.length, 2, 'cancellation never starts a sticky SSE attempt');
  f.transport.close();
  const fresh = await f.request();
  f.Socket.instances.at(-1).event(completed); await fresh.text();
  assert.equal(f.Socket.instances.length, 3, 'session teardown clears the breaker');
});

test('WS success resets failures; explicit WS and disabled sticky fallback remain strict', async t => {
  for (const options of [{ transport: 'websocket' }, { transport: 'auto', fallbackAfterFailures: 0 }]) {
    const f = fixture({ ...options, fetch: async () => assert.fail('unexpected SSE') });
    t.after(() => f.transport.close());
    await disconnect(f); await disconnect(f); await disconnect(f);
    assert.equal(f.Socket.instances.length, 3);
  }
  const f = fixture({ transport: 'auto', fetch: async () => assert.fail('unexpected SSE') });
  t.after(() => f.transport.close());
  await disconnect(f);
  const success = await f.request(); f.Socket.instances.at(-1).event(completed); await success.text();
  await disconnect(f);
  const next = await f.request(); f.Socket.instances.at(-1).event(completed); await next.text();
});

test('cancellation and server errors do not open the breaker or send HTTP requests', async t => {
  const f = fixture({ transport: 'auto', fetch: async () => assert.fail('unexpected SSE') });
  t.after(() => f.transport.close());
  for (let i = 0; i < 2; i++) {
    const abort = new AbortController();
    const response = await f.request(abort.signal); abort.abort();
    await assert.rejects(response.text(), { name: 'AbortError' });
  }
  for (let i = 0; i < 2; i++) {
    const response = await f.request();
    f.Socket.instances.at(-1).event({ type: 'error', error: { code: 'insufficient_quota' } });
    assert.match(await response.text(), /insufficient_quota/);
  }
  const response = await f.request(); f.Socket.instances.at(-1).event(completed); await response.text();
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.request(cancelled.signal), { name: 'AbortError' });
});

test('sticky fallback is isolated by model, session and credentials', async t => {
  const f = fixture({ transport: 'auto', fetch: async () => new Response('HTTP') });
  t.after(() => f.transport.close());
  await disconnect(f); await disconnect(f);
  const otherModel = await f.request(undefined, { model: 'other' });
  f.Socket.instances.at(-1).event(completed); await otherModel.text();
  for (const options of [{ sessionId: 'other' }, { sessionId: 'test', headers: { authorization: 'Bearer other' } }]) {
    const fetch = f.transport.fetchFor({ ...options, transport: 'auto' });
    const response = await fetch('https://example.test/v1/responses', { method: 'POST', headers: options.headers ?? { authorization: 'Bearer test-fixture', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture', input: [], stream: true, store: false }) });
    f.Socket.instances.at(-1).event(completed); await response.text();
  }
  assert.equal(f.Socket.instances.length, 5);
});

test('maximum connection age and no-reuse diagnostics open full-history sockets', async t => {
  let clock = 0;
  const f = fixture({ transport: 'auto', runtime: { now: () => clock } }); t.after(() => f.transport.close());
  const first = await f.request(undefined, { input: [user('one')] });
  completeCached(f, f.Socket.instances[0], 'resp_1', [assistant('a')]); await first.text();
  clock = 55 * 60_000;
  const second = await f.request(undefined, { input: [user('one'), assistant('a'), user('two')] });
  assert.equal(f.Socket.instances.length, 2);
  assert.equal(f.Socket.instances[1].sent[0].previous_response_id, undefined);
  f.Socket.instances[1].event(completed); await second.text();
  const fresh = fixture({ transport: 'auto', reuseConnection: false }); t.after(() => fresh.transport.close());
  for (let i = 0; i < 2; i++) { const response = await fresh.request(); fresh.Socket.instances.at(-1).event(completed); await response.text(); }
  assert.equal(fresh.Socket.instances.length, 2);
});

test('connection errors are retryable by Pi and retain only allowlisted error codes', async t => {
  const { isRetryableAssistantError } = await import('@earendil-works/pi-ai/compat');
  const f = fixture({ transport: 'websocket', deferOpen: true }); t.after(() => f.transport.close());
  const pending = f.request();
  await new Promise(resolve => setImmediate(resolve));
  f.Socket.instances[0].emit('error', Object.assign(new Error('private credential in source error'), { code: 'ECONNRESET' }));
  const error = await pending.catch(error => error);
  assert.equal(isRetryableAssistantError({ stopReason: 'error', errorMessage: error.message }), true);
  assert.match(error.message, /ECONNRESET/);
  assert.doesNotMatch(error.message, /private credential/);
});

test('certificate and protocol errors are not classified as temporary connection failures', async t => {
  const { isRetryableAssistantError } = await import('@earendil-works/pi-ai/compat');
  for (const code of ['ERR_TLS_CERT_ALTNAME_INVALID', 'WS_ERR_INVALID_OPCODE']) {
    const f = fixture({ transport: 'auto', deferOpen: true, fetch: async () => assert.fail('unexpected SSE') });
    t.after(() => f.transport.close());
    const pending = f.request(); await new Promise(resolve => setImmediate(resolve));
    f.Socket.instances[0].emit('error', Object.assign(new Error('private server details'), { code }));
    const error = await pending.catch(error => error);
    assert.equal(isRetryableAssistantError({ stopReason: 'error', errorMessage: error.message }), false);
    assert.match(error.message, new RegExp(code));
    assert.doesNotMatch(error.message, /private server details|network error:/);
  }
});
