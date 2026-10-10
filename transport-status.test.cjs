'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTransportStatus } = require('./transport-status.cjs');

function fixture() {
  let clock = 10_000;
  let nextTimer = 0;
  const timers = new Map();
  const statuses = [];
  const notifications = [];
  const diagnostics = [];
  const ctx = { mode: 'tui', hasUI: true, ui: {
    setStatus: (_key, text) => statuses.push(text),
    notify: text => notifications.push(text),
  } };
  const status = createTransportStatus({ now: () => clock,
    setInterval: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval: id => timers.delete(id), onDiagnostic: data => diagnostics.push(data),
  });
  status.start(ctx);
  return { status, ctx, timers, statuses, notifications, diagnostics,
    advance(ms) { clock += ms; for (const callback of timers.values()) callback(); },
    state(patch = {}) { return { requestId: 1, startedAt: 10_000, transport: 'websocket', phase: 'waiting', requestSent: true, ...patch }; },
  };
}

test('elapsed status distinguishes server events from output and only settles at the final boundary', () => {
  const f = fixture(); const owner = Symbol();
  f.status.observe(f.state(), owner);
  assert.match(f.statuses.at(-1), /Waiting for WS server events/);
  f.advance(31_000);
  assert.match(f.statuses.at(-1), /taking longer than usual.*31s/);
  f.status.observe(f.state({ phase: 'streaming', lastEventAt: 41_000 }), owner);
  assert.match(f.statuses.at(-1), /events received; no output yet/);
  f.status.observe(f.state({ phase: 'failed', errorKind: 'closed', closeCode: 1006 }), owner);
  f.status.result({ stopReason: 'error', errorMessage: 'do not retain private server content' }, owner);
  f.advance(2000);
  assert.equal(f.timers.size, 1, 'waiting for Pi recovery is still active');
  f.status.settle();
  assert.equal(f.timers.size, 0);
  assert.match(f.statuses.at(-1), /Recovery stopped/);
  assert.equal(f.diagnostics.length, 1);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /private server content/);
  const finalCount = f.statuses.length;
  f.advance(60_000);
  assert.equal(f.statuses.length, finalCount);
});

test('SSE recovery updates output status, saves bounded metadata and leaves no false final error', () => {
  const f = fixture(); const failed = Symbol(); const recovered = Symbol();
  f.status.observe(f.state({ phase: 'fallback_pending', failures: 2, payload: 'private prompt', headers: { authorization: 'secret' } }), failed);
  f.status.result({ stopReason: 'error' }, failed);
  f.status.observe(f.state({ requestId: 2, transport: 'sse', phase: 'connecting', reason: 'sticky_fallback' }), recovered);
  f.status.providerEvent({ type: 'response.created', response: { id: 'private response' } }, recovered);
  assert.match(f.statuses.at(-1), /SSE events received; no output yet/);
  f.status.providerEvent({ type: 'response.output_item.added', item: { type: 'reasoning' } }, recovered);
  f.status.providerEvent({ type: 'response.reasoning_text.delta', delta: '' }, recovered);
  assert.match(f.statuses.at(-1), /no output yet/);
  f.status.providerEvent({ type: 'response.output_text.delta', delta: 'private text' }, recovered);
  assert.match(f.statuses.at(-1), /SSE output received/);
  f.status.result({ stopReason: 'stop' }, recovered);
  f.status.settle();
  assert.equal(f.timers.size, 0);
  assert.equal(f.statuses.at(-1), undefined);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.diagnostics[0].outcome, 'stop');
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /private|secret|authorization|payload/);
});

test('abort, reload and stale callbacks cannot restart status timers or send recovery notices', () => {
  const f = fixture(); const owner = Symbol();
  f.status.observe(f.state(), owner);
  f.status.result({ stopReason: 'aborted' }, owner);
  f.status.settle(true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.notifications.length, 0);
  f.status.start(f.ctx);
  f.status.observe(f.state(), owner);
  const staleGeneration = f.status.generation();
  f.status.clear();
  f.status.start(f.ctx);
  f.status.observe(f.state({ phase: 'fallback_pending' }), owner, staleGeneration);
  f.status.providerEvent({ type: 'response.output_text.delta' }, owner);
  f.status.result({ stopReason: 'error' }, owner);
  f.status.settle();
  assert.equal(f.timers.size, 0);
  assert.equal(f.notifications.length, 0);
  assert.equal(f.statuses.at(-1), undefined);
});

test('completion of an older request does not clear a newer request status', () => {
  const f = fixture(); const first = Symbol(); const second = Symbol();
  f.status.observe(f.state(), first);
  f.status.observe(f.state({ requestId: 2 }), second);
  f.status.observe(f.state({ phase: 'completed' }), first);
  f.status.result({ stopReason: 'stop' }, first);
  assert.equal(f.timers.size, 1);
  assert.match(f.statuses.at(-1), /Waiting/);
  f.status.observe(f.state({ requestId: 2, phase: 'completed' }), second);
  f.status.result({ stopReason: 'stop' }, second);
  f.status.settle();
  assert.equal(f.timers.size, 0);
});

test('headless recovery keeps at most 32 diagnostic records and never starts UI timers', () => {
  const f = fixture(); const owner = Symbol();
  f.status.start({ mode: 'json', hasUI: false, ui: { notify: () => assert.fail('headless UI') } });
  for (let i = 0; i < 50; i++) f.status.observe(f.state({ phase: 'failed', closeCode: 1006 }), owner);
  f.status.observe(f.state({ phase: 'fallback_pending' }), owner);
  f.status.result({ stopReason: 'error' }, owner);
  f.status.settle();
  assert.equal(f.timers.size, 0);
  assert.equal(f.diagnostics[0].records.length, 32);
  assert.equal(f.diagnostics[0].records[0].phase, 'failed');
});

test('successful WS recovery clears old failed status before tools run', () => {
  const f = fixture(); const failed = Symbol(); const next = Symbol();
  f.status.observe(f.state({ phase: 'failed' }), failed);
  f.status.result({ stopReason: 'error' }, failed);
  f.status.observe(f.state({ requestId: 2 }), next);
  f.status.observe(f.state({ requestId: 2, phase: 'completed' }), next);
  f.status.result({ stopReason: 'toolUse' }, next);
  assert.equal(f.statuses.at(-1), undefined);
  assert.equal(f.timers.size, 0);
  f.status.settle();
  assert.equal(f.notifications.length, 0);
});

test('SSE completion restores the status of a still-running concurrent request', () => {
  const f = fixture(); const older = Symbol(); const newer = Symbol();
  f.status.observe(f.state({ transport: 'sse' }), older);
  f.status.observe(f.state({ requestId: 2, transport: 'sse' }), newer);
  f.status.result({ stopReason: 'stop' }, newer);
  assert.equal(f.timers.size, 1);
  assert.match(f.statuses.at(-1), /Waiting for SSE/);
  f.status.result({ stopReason: 'stop' }, older);
  assert.equal(f.timers.size, 0);
  f.status.settle();
});

test('long recovered tool turns retain the initial failure without growing diagnostics', () => {
  const f = fixture(); const failed = Symbol();
  f.status.observe(f.state({ phase: 'failed', closeCode: 1006 }), failed);
  f.status.result({ stopReason: 'error' }, failed);
  for (let requestId = 2; requestId < 52; requestId++) {
    const owner = Symbol();
    f.status.observe(f.state({ requestId, transport: 'sse' }), owner);
    f.status.result({ stopReason: 'toolUse' }, owner);
  }
  f.status.settle();
  assert.equal(f.diagnostics.length, 1);
  assert.equal(f.diagnostics[0].records.length, 32);
  assert.equal(f.diagnostics[0].records[0].closeCode, 1006);
  assert.equal(f.diagnostics[0].outcome, 'toolUse');
});
