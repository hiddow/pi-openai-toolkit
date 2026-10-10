'use strict';

// Transport-only observations: never retain messages, payloads, URLs or auth headers.
function createTransportStatus({ slowResponseWarningMs = 30_000, onDiagnostic = (_data) => {}, now = Date.now,
  setInterval: startTimer = setInterval, clearInterval: stopTimer = clearInterval } = {}) {
  const statusKey = 'pi-openai-transport';
  const requests = new Map();
  const records = [];
  let context;
  let active = false;
  let epoch = 0;
  let currentOwner;
  let timer;
  let lastOutcome;
  let lastOutcomeRequestId = 0;
  let fallbackNotified = false;

  function stop() { if (timer !== undefined) stopTimer(timer); timer = undefined; }
  function ui() { return context?.mode === 'tui' && context.hasUI ? context.ui : undefined; }
  function record(state) {
    const keys = ['requestId', 'connectionId', 'transport', 'phase', 'requestSent', 'reused', 'context',
      'inputItems', 'fullInputItems', 'httpStatus', 'closeCode', 'errorKind', 'errorCode', 'reason', 'failures'];
    const entry = { timestamp: now(), elapsedMs: Math.max(0, now() - state.startedAt) };
    for (const key of keys) if (state[key] !== undefined) entry[key] = state[key];
    records.push(entry);
    // Retain the first failure even when a recovered turn runs many more tools.
    if (records.length > 32) records.splice(['failed', 'fallback_pending'].includes(records[0].phase) ? 1 : 0, 1);
  }
  function render() {
    const state = requests.get(currentOwner);
    const target = ui();
    if (!active || !state || !target) return;
    const seconds = Math.floor(Math.max(0, now() - state.startedAt) / 1000);
    const transport = state.transport === 'sse' ? 'SSE' : 'WS';
    let text;
    switch (state.phase) {
      case 'connecting': text = `Connecting ${transport}`; break;
      case 'waiting': text = `Waiting for ${transport} server events`; break;
      case 'streaming': {
        const idle = Math.floor(Math.max(0, now() - (state.lastEventAt ?? state.startedAt)) / 1000);
        text = state.lastProgressAt !== undefined ? `${transport} output received` : `${transport} events received; no output yet`;
        text += ` · last event ${idle}s ago`;
        break;
      }
      case 'fallback_pending': text = 'WS failed repeatedly; next Pi attempt will use SSE'; break;
      case 'failed': text = `${transport} request failed; Pi decides whether to retry`; break;
      default: return;
    }
    if (['connecting', 'waiting', 'streaming'].includes(state.phase)
      && now() - (state.lastProgressAt ?? state.startedAt) >= slowResponseWarningMs) text += ' · taking longer than usual';
    target.setStatus(statusKey, `${text} · ${seconds}s`);
    // Leave Pi's own retry countdown/loader untouched; only own the status slot.
  }
  function ensureTimer() {
    if (timer === undefined && ui()) { timer = startTimer(render, 1000); timer.unref?.(); }
  }
  function resumePending() {
    const pending = [...requests].filter(([_key, state]) => !state.settled && !['completed', 'cancelled'].includes(state.phase)).at(-1);
    currentOwner = pending?.[0];
    if (pending) { render(); ensureTimer(); }
    else { stop(); ui()?.setStatus(statusKey, undefined); }
  }
  function bind(ctx) { context = ctx; }
  function start(ctx) {
    clear();
    bind(ctx);
    active = true;
  }
  function observe(state, owner, generation = epoch) {
    if (!active || generation !== epoch) return;
    const previous = requests.get(owner);
    requests.set(owner, { ...state });
    if (!['completed', 'cancelled'].includes(state.phase) || currentOwner === undefined) currentOwner = owner;
    if (state.phase === 'connecting' && (!previous || previous.transport !== state.transport)) record(state);
    if (['failed', 'fallback_pending'].includes(state.phase)) record(state);
    if ((state.phase === 'fallback_pending' || state.reason === 'unsupported_upgrade') && !fallbackNotified) {
      fallbackNotified = true;
      if (context?.hasUI) context.ui.notify('WebSocket unavailable. Subsequent auto requests on this route use SSE until reload or session replacement.', 'warning');
    }
    if (['completed', 'cancelled'].includes(state.phase)) {
      if (owner !== currentOwner) return;
      resumePending();
    } else {
      render();
      ensureTimer();
    }
  }
  function providerEvent(event, owner, generation = epoch) {
    const state = requests.get(owner);
    if (!active || generation !== epoch || !state || state.transport !== 'sse') return;
    const type = event?.type;
    if (typeof type !== 'string') return;
    state.lastEventAt = now();
    if (/^response\.(output_text|reasoning.*|function_call_arguments|custom_tool_call_input)\.delta$/.test(type) && typeof event.delta === 'string' && event.delta.length > 0) state.lastProgressAt = now();
    state.phase = 'streaming';
    render();
  }
  function result(message, owner, generation = epoch) {
    const state = requests.get(owner);
    if (!active || generation !== epoch || !state) return;
    const outcome = message.stopReason;
    state.settled = true;
    if (state.requestId >= lastOutcomeRequestId) { lastOutcome = outcome; lastOutcomeRequestId = state.requestId; }
    if (['stop', 'toolUse'].includes(outcome)) {
      record({ ...state, phase: 'completed' });
      requests.delete(owner);
      if (owner === currentOwner) resumePending();
    } else if (outcome === 'aborted') {
      requests.delete(owner);
      if (owner === currentOwner) resumePending();
    } else if (owner === currentOwner || (currentOwner === undefined && state.requestId >= lastOutcomeRequestId)) {
      currentOwner = owner;
      const alreadyFailed = ['failed', 'fallback_pending'].includes(state.phase);
      state.phase = state.phase === 'fallback_pending' ? 'fallback_pending' : 'failed';
      state.errorKind ??= 'provider';
      if (!alreadyFailed) record(state);
      render();
      ensureTimer();
    }
  }
  function settle(aborted = false) {
    stop();
    if (records.some(record => ['failed', 'fallback_pending'].includes(record.phase))) {
      try { onDiagnostic({ schemaVersion: 1, outcome: aborted ? 'aborted' : lastOutcome, records: [...records] }); }
      catch { /* Diagnostics must not change the run outcome. */ }
    }
    if (!aborted && lastOutcome === 'error') {
      ui()?.setStatus(statusKey, 'Recovery stopped; completed tool changes remain');
      if (context?.hasUI) context.ui.notify('Automatic recovery stopped. Completed tool changes remain; check the existing diff before resuming.', 'warning');
    } else ui()?.setStatus(statusKey, undefined);
    active = false;
    requests.clear();
    records.length = 0;
  }
  function clear() {
    epoch++;
    stop();
    ui()?.setStatus(statusKey, undefined);
    active = false;
    currentOwner = undefined;
    requests.clear();
    records.length = 0;
    lastOutcome = undefined;
    lastOutcomeRequestId = 0;
    fallbackNotified = false;
    context = undefined;
  }
  return { bind, start, observe, providerEvent, result, settle, clear, generation: () => epoch };
}
module.exports = { createTransportStatus };
