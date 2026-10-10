'use strict';
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

// Protocol and checkpoint reconciliation informed by awoaCrim/pi-openai-toolkit
// (MIT), commit 9844924f82c21937cf3c54942cec5af0b57dab6d. See NOTICE.md.
const MARKER_PREFIX = '[pi-openai-bridge:remote-v2:';
const DETAIL_KEY = 'piOpenAICompaction';
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function safeError(message) { const error = new Error(message); error.compactionSafe = true; return error; }
function endpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw safeError('Remote compaction requires an HTTP(S) base URL without credentials, query or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}
function isCheckpoint(item) { return record(item) && item.type === 'compaction' && nonempty(item.encrypted_content); }
function reconcileCheckpoint(terminal, itemDone, responseIds) {
  if (terminal?.type !== 'response.completed' || terminal.response?.status !== 'completed') {
    throw safeError('Remote compaction did not complete successfully.');
  }
  const responseId = terminal.response.id;
  if (responseId !== undefined && !nonempty(responseId)) throw safeError('Remote compaction returned an invalid response identity.');
  if (responseIds.some(id => responseId !== undefined && id !== responseId)) throw safeError('Remote compaction returned conflicting response identities.');
  const usage = terminal.response.usage;
  if (usage !== undefined && (!record(usage) || ['input_tokens', 'output_tokens', 'total_tokens'].some(key =>
      usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key] < 0)))) {
    throw safeError('Remote compaction returned invalid usage metadata.');
  }
  const output = terminal.response.output;
  if (!Array.isArray(output) || output.length > 1 || itemDone.length > 1) {
    throw safeError('Remote V2 must return exactly one compaction item.');
  }
  const candidates = [...itemDone, ...output];
  if (!candidates.length || candidates.some(item => !isCheckpoint(item))) {
    throw safeError('Remote compaction returned an empty or invalid checkpoint.');
  }
  const merged = {};
  for (const candidate of candidates) {
    if ((candidate.id !== undefined && !nonempty(candidate.id)) ||
        (candidate.output_index !== undefined && candidate.output_index !== 0) ||
        (candidate.response_id !== undefined && (!nonempty(candidate.response_id) || (responseId !== undefined && candidate.response_id !== responseId)))) {
      throw safeError('Remote compaction returned invalid checkpoint metadata.');
    }
    for (const [key, value] of Object.entries(candidate)) {
      if (Object.hasOwn(merged, key) && !isDeepStrictEqual(merged[key], value)) {
        throw safeError('Remote compaction returned conflicting checkpoint evidence.');
      }
      Object.defineProperty(merged, key, { value: structuredClone(value), enumerable: true, configurable: true, writable: true });
    }
  }
  if (Object.hasOwn(merged, 'id') && !nonempty(merged.id)) throw safeError('Remote compaction returned invalid checkpoint metadata.');
  return { checkpoint: merged, usage: terminal.response.usage };
}
async function readCheckpoint(response, signal) {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw safeError('Remote V2 requires a streaming SSE response.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let line = '', skipLf = false, data = [], totalBytes = 0;
  const items = [], responseIds = [];
  function consumeLine() {
    const current = line; line = '';
    if (current !== '') {
      if (current === 'data' || current.startsWith('data:')) data.push(current.slice(5).replace(/^ /, ''));
      return;
    }
    if (!data.length) return;
    const raw = data.join('\n'); data = [];
    if (raw === '[DONE]') throw safeError('Remote compaction ended without a completed checkpoint.');
    let event;
    try { event = JSON.parse(raw); } catch { throw safeError('Remote compaction returned malformed SSE data.'); }
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      throw safeError('Remote compaction returned a terminal error.');
    }
    if (event.type === 'response.output_item.done') {
      if (event.output_index !== undefined && event.output_index !== 0) throw safeError('Remote compaction returned an invalid output index.');
      if (event.response_id !== undefined) {
        if (!nonempty(event.response_id)) throw safeError('Remote compaction returned an invalid response identity.');
        responseIds.push(event.response_id);
      }
      items.push(event.item);
    }
    if (event.type === 'response.completed') return reconcileCheckpoint(event, items, responseIds);
  }
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) throw safeError('Remote compaction stream ended before a complete SSE frame.');
      totalBytes += value.byteLength;
      if (totalBytes > MAX_STREAM_BYTES) throw safeError('Remote compaction response exceeded the size limit.');
      for (const character of decoder.decode(value, { stream: true })) {
        if (skipLf) { skipLf = false; if (character === '\n') continue; }
        if (character !== '\n' && character !== '\r') { line += character; continue; }
        skipLf = character === '\r';
        const result = consumeLine();
        if (result) return result;
      }
    }
  } finally {
    // A validated terminal is authoritative. An open/hung body must not block it.
    void reader.cancel().catch(() => {});
  }
}
async function executeRemoteCompaction({ baseUrl, headers, payload, signal, timeoutMs, fetchFn = fetch }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  combined.throwIfAborted();
  const requestHeaders = new Headers(headers);
  requestHeaders.set('content-type', 'application/json'); requestHeaders.set('accept', 'text/event-stream');
  requestHeaders.delete('content-length');
  const body = { ...structuredClone(payload), input: [
    ...payload.input.filter(item => item.type !== 'configuration_update'), { type: 'compaction_trigger' },
  ], store: false, stream: true };
  delete body.previous_response_id; delete body.max_output_tokens;
  delete body.prompt_cache_key; delete body.prompt_cache_retention; delete body.prompt_cache_options;
  try {
    const response = await fetchFn(`${endpoint(baseUrl)}/responses`, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify(body), signal: combined, redirect: 'error',
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw safeError(`Remote compaction rejected (HTTP ${response.status}).`);
    }
    return await readCheckpoint(response, combined);
  } catch (error) {
    if (signal?.aborted) throw safeError('Remote compaction was cancelled.');
    if (timeout.aborted) throw safeError('Remote compaction timed out; no checkpoint was saved.');
    throw error.compactionSafe ? error : safeError('Remote compaction failed; no checkpoint was saved.');
  }
}
function latestCompaction(manager) { return manager.getBranch().findLast(entry => entry.type === 'compaction'); }
function checkpointDetails(entry) {
  const details = entry?.details?.[DETAIL_KEY];
  if (!details && !entry?.summary?.startsWith(MARKER_PREFIX)) return;
  if (!record(details) || details.version !== 1 || details.protocol !== 'remote-v2' || !isCheckpoint(details.checkpoint) ||
      !nonempty(details.provider) || !nonempty(details.model) || !nonempty(details.baseUrl) ||
      !Array.isArray(details.sealedEntryIds) || !details.sealedEntryIds.every(nonempty) ||
      details.inputProvenance !== 'pi-preparation-prefix-v1' || !entry.summary.startsWith(MARKER_PREFIX)) {
    throw safeError('Remote checkpoint metadata is invalid. Navigate before this checkpoint to recover.');
  }
  return details;
}
function verifyCheckpointScope(entry, manager, model, baseUrl, settings) {
  const details = checkpointDetails(entry);
  if (!details) return;
  if (model?.api !== 'openai-responses' || details.provider !== model.provider || details.model !== model.id ||
      endpoint(baseUrl) !== endpoint(details.baseUrl) || !settings.models.includes(`${model.provider}/${model.id}`)) {
    throw safeError('Remote checkpoint requires its original configured provider, model and endpoint.');
  }
  const branch = manager.getBranch();
  const index = branch.findIndex(item => item.id === entry.id);
  if (index < 0 || branch.slice(index + 1).some(item => item.type === 'context_edit' &&
      (item.targetId === entry.id || details.sealedEntryIds.includes(item.targetId)))) {
    throw safeError('History sealed in a remote checkpoint was edited. Navigate before the checkpoint or start a new session.');
  }
  return details;
}
function textOfItem(item) {
  if (typeof item?.content === 'string') return item.content;
  return Array.isArray(item?.content) ? item.content.filter(block => ['text', 'input_text', 'output_text'].includes(block.type)).map(block => block.text).join('\n') : '';
}
/** Use the host SDK's exact conversion without performing inference or a fetch. */
async function prepareResponsesPayload(api, model, messages, options) {
  let captured;
  await api.streamSimple(model, { messages }, {
    ...options, maxRetries: 0,
    fetch: async () => { throw safeError('Unexpected network access during compaction preparation.'); },
    onPayload: payload => { captured = structuredClone(payload); throw safeError('Compaction payload prepared locally.'); },
  }).result();
  if (!record(captured) || !Array.isArray(captured.input)) throw safeError('Pi could not prepare the remote compaction input.');
  return captured;
}
function createCompactionController(settings, helpers) {
  const receipts = new Map();
  let toolHead, headSession;
  function captureHead(messages, ctx) {
    headSession = ctx.sessionManager.getSessionId();
    toolHead = helpers.getCurrentTools(helpers.convertToLlm(messages));
  }
  function summaryText(entry) {
    return textOfItem(helpers.convertToLlm([{ role: 'compactionSummary', summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: 0 }])[0]);
  }
  function markerForMessage(message) {
    if (message.role === 'compactionSummary') return message.summary.startsWith(MARKER_PREFIX) ? message.summary : undefined;
    if (message.role !== 'user') return;
    const [prefix, suffix] = summaryText({ summary: '__BRIDGE_ANCHOR__', tokensBefore: 0 }).split('__BRIDGE_ANCHOR__');
    const text = textOfItem(message);
    if (text.startsWith(prefix + MARKER_PREFIX) && text.endsWith(suffix)) return text.slice(prefix.length, -suffix.length);
  }
  async function rewritePayload(payload, ctx) {
    const entry = latestCompaction(ctx.sessionManager);
    const stored = checkpointDetails(entry);
    if (!stored) return payload;
    if (!record(payload) || !Array.isArray(payload.input)) throw safeError('Remote checkpoint replay requires Responses input.');
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok) throw safeError('Cannot authenticate remote checkpoint replay.');
    const details = verifyCheckpointScope(entry, ctx.sessionManager, ctx.model, auth.baseUrl ?? ctx.model.baseUrl, settings);
    const anchor = summaryText(entry);
    const indices = payload.input.flatMap((item, index) => item.role === 'user' && textOfItem(item) === anchor ? [index] : []);
    if (indices.length !== 1) throw safeError('Remote checkpoint summary anchor was removed or changed by a context transform.');
    const result = structuredClone(payload);
    result.input.splice(indices[0], 1, structuredClone(details.checkpoint));
    delete result.previous_response_id;
    receipts.clear(); receipts.set(entry.summary, details.checkpoint);
    return result;
  }
  function assertReplayPayload(payload, messages) {
    const markers = messages.map(markerForMessage).filter(Boolean);
    if (!markers.length) return;
    for (const marker of markers) {
      const receipt = receipts.get(marker);
      if (!receipt || !Array.isArray(payload?.input) || !payload.input.some(item => isDeepStrictEqual(item, receipt)) ||
          payload.input.some(item => markerForMessage(item) === marker)) {
        throw safeError('Remote checkpoint replay was not verified; the provider request was stopped.');
      }
    }
  }
  async function compact(event, ctx) {
    const previousEntry = latestCompaction(ctx.sessionManager);
    let previous;
    try { previous = checkpointDetails(previousEntry); }
    catch (error) { ctx.ui.notify(error.message, 'error'); return { cancel: true }; }
    const eligible = ctx.model?.api === 'openai-responses' && settings.models.includes(`${ctx.model.provider}/${ctx.model.id}`);
    if (!settings.enabled || !eligible) {
      if (previous) { ctx.ui.notify('Re-enable remote compaction on the checkpoint model before compacting again.', 'error'); return { cancel: true }; }
      return;
    }
    try {
      event.signal.throwIfAborted();
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) throw safeError('Cannot resolve remote compaction credentials.');
      const baseUrl = endpoint(auth.baseUrl ?? ctx.model.baseUrl);
      if (previous) verifyCheckpointScope(previousEntry, ctx.sessionManager, ctx.model, baseUrl, settings);
      const preparation = event.preparation;
      const projection = ctx.sessionManager.buildSessionProjection();
      if (!projection || !Array.isArray(projection.entries)) throw safeError('Pi session projection is unavailable.');
      const boundary = projection.entries.findIndex(item => item.sourceEntry.id === preparation.firstKeptEntryId);
      if (boundary < 0) throw safeError('Pi compaction boundary is unavailable.');
      const prefix = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages].filter(message => message.role !== 'system');
      if (!previous && preparation.previousSummary) prefix.unshift({ role: 'compactionSummary', summary: preparation.previousSummary, tokensBefore: preparation.tokensBefore, timestamp: 0 });
      const tools = headSession === ctx.sessionManager.getSessionId() && toolHead ? toolHead : helpers.getCurrentTools(helpers.convertToLlm(projection.messages));
      const messages = helpers.convertToLlm([{ role: 'system', content: ctx.getSystemPrompt(), toolsAdded: tools, timestamp: 0 }, ...prefix]);
      const headers = new Headers({ ...ctx.model.headers, ...auth.headers });
      if (!headers.has('authorization') && auth.apiKey) headers.set('authorization', `Bearer ${auth.apiKey}`);
      const requestModel = { ...ctx.model, baseUrl };
      const payload = await prepareResponsesPayload(helpers.api(), requestModel, messages, { apiKey: auth.apiKey, headers: Object.fromEntries(headers), cacheRetention: 'none' });
      if (previous) {
        if (payload.input.some(markerForMessage)) throw safeError('An opaque checkpoint was serialized as text.');
        // Current prompt and tool head stay ahead of the checkpoint, then the new prefix.
        const firstConversation = payload.input.findIndex(item => !['system', 'developer'].includes(item.role));
        payload.input.splice(firstConversation < 0 ? payload.input.length : firstConversation, 0, structuredClone(previous.checkpoint));
      }
      if (event.customInstructions) payload.instructions = event.customInstructions;
      const result = await executeRemoteCompaction({ baseUrl, headers, payload, signal: event.signal, timeoutMs: settings.timeoutMs });
      const summary = `${MARKER_PREFIX}${randomUUID()}]`;
      const sealedEntryIds = [...new Set([...(previous?.sealedEntryIds ?? []), ...projection.entries.slice(0, boundary).filter(item => item.messages.length).map(item => item.sourceEntry.id)])];
      const usage = helpers.toUsage(result.usage, ctx.model);
      return { compaction: {
        summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, usage,
        details: { [DETAIL_KEY]: { version: 1, protocol: 'remote-v2', inputProvenance: 'pi-preparation-prefix-v1', provider: ctx.model.provider, model: ctx.model.id, baseUrl, checkpoint: result.checkpoint, sealedEntryIds } },
      } };
    } catch (error) {
      const message = error.compactionSafe ? error.message : 'Remote compaction preparation failed; context was preserved.';
      if (event.signal.aborted || previous) { ctx.ui.notify(message, 'error'); return { cancel: true }; }
      ctx.ui.notify(`${message} Using Pi's text summary instead.`, 'warning');
      return;
    }
  }
  function reset() { receipts.clear(); toolHead = undefined; headSession = undefined; }
  return { compact, rewritePayload, assertReplayPayload, captureHead, reset };
}
module.exports = { createCompactionController, executeRemoteCompaction, readCheckpoint, checkpointDetails, prepareResponsesPayload, MARKER_PREFIX };
