'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const { findPackageJSON } = require('node:module');
const { createServer } = require('node:http');
const { createCompactionController, readCheckpoint, executeRemoteCompaction, MARKER_PREFIX } = require('./remote-compaction.cjs');
const { parseConfig } = require('./config.cjs');
const checkpoint = { type: 'compaction', id: 'cmp_fixture', encrypted_content: 'opaque-fixture-only', future_field: { retained: true } };
const eventFrame = event => `data: ${JSON.stringify(event)}\r\n\r\n`;
const completed = (output = [checkpoint]) => ({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output, usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } } });
function streamResponse(events, close = true) {
  return new Response(new ReadableStream({ start(controller) {
    const bytes = Buffer.from(events.map(eventFrame).join(''));
    // Split both UTF-8 and CRLF boundaries.
    for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.subarray(index, index + 7));
    if (close) controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
test('V2 accepts a validated terminal on an open body and preserves unknown checkpoint fields', async () => {
  const result = await readCheckpoint(streamResponse([
    { type: 'response.output_item.done', output_index: 0, item: checkpoint }, completed(),
  ], false));
  assert.deepEqual(result.checkpoint, checkpoint);
  assert.equal(result.usage.total_tokens, 24);
  assert.deepEqual((await readCheckpoint(streamResponse([{ type: 'response.output_item.done', item: checkpoint }, completed([])]))).checkpoint, checkpoint);
});
test('V2 rejects incomplete, conflicting, malformed and error checkpoints', async () => {
  for (const events of [
    [completed([])], [completed([{ type: 'compaction', encrypted_content: '' }])],
    [completed([checkpoint, checkpoint])],
    [{ type: 'response.output_item.done', item: { ...checkpoint, encrypted_content: 'conflict' } }, completed()],
    [{ type: 'response.output_item.done', output_index: 1, item: checkpoint }, completed()],
    [{ type: 'response.output_item.done', response_id: 'foreign_response', item: checkpoint }, completed()],
    [completed([{ ...checkpoint, output_index: 1 }])],
    [{ type: 'response.incomplete', response: { output: [checkpoint] } }],
  ]) await assert.rejects(readCheckpoint(streamResponse(events)));
  await assert.rejects(readCheckpoint(new Response(`data: ${JSON.stringify(completed())}`, { headers: { 'content-type': 'text/event-stream' } })), /complete SSE frame/);
});
test('compaction cancellation and HTTP failures never save a checkpoint, retry, or expose response bodies', async () => {
  let calls = 0;
  const options = { baseUrl: 'https://fixture.test/v1', headers: {}, payload: { model: 'fixture', input: [] }, timeoutMs: 1000 };
  await assert.rejects(executeRemoteCompaction({ ...options, fetchFn: async () => {
    calls++; return new Response('private upstream error body', { status: 401 });
  } }), error => error.message.includes('HTTP 401') && !error.message.includes('private'));
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executeRemoteCompaction({ ...options, signal: controller.signal, fetchFn: async () => { calls++; } }));
  assert.equal(calls, 1);
});
test('ordinary source-code references to the marker prefix are not mistaken for checkpoint anchors', async () => {
  const host = dirname(findPackageJSON('@earendil-works/pi-coding-agent', pathToFileURL(__filename)));
  const { convertToLlm } = await import(pathToFileURL(join(host, 'dist/core/messages.js')).href);
  const controller = createCompactionController({ models: [] }, { convertToLlm });
  assert.doesNotThrow(() => controller.assertReplayPayload({ input: [] }, [
    { role: 'toolResult', content: [{ type: 'text', text: `const MARKER_PREFIX = '${MARKER_PREFIX}';` }] },
    { role: 'user', content: [{ type: 'text', text: `Please explain ${MARKER_PREFIX}` }] },
  ]));
  assert.throws(() => controller.assertReplayPayload({ input: [] }, convertToLlm([
    { role: 'compactionSummary', summary: `${MARKER_PREFIX}fixture]`, tokensBefore: 1, timestamp: 0 },
  ])), /not verified/);
});
test('remote compaction configuration is opt-in and uses exact provider/model identities', () => {
  assert.equal(parseConfig({ schemaVersion: 2, defaults: {} }).remoteCompaction.enabled, false);
  assert.throws(() => parseConfig({ schemaVersion: 2, defaults: { remoteCompaction: { enabled: true } } }), /nonempty models/);
  assert.throws(() => parseConfig({ schemaVersion: 2, defaults: { remoteCompaction: { models: ['provider-only'] } } }), /exact/);
  assert.throws(() => parseConfig({ schemaVersion: 2, defaults: { remoteCompaction: { timeoutMs: 0 } } }), /timeoutMs/);
});

test('real Pi persists/reopens/recompacts opaque prefixes, preserves full tool results and SSE tools, and blocks sealed edits', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-remote-compaction-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configPath = join(cwd, 'config.json');
  const previousConfig = process.env.PI_OPENAI_TOOLKIT_CONFIG;
  process.env.PI_OPENAI_TOOLKIT_CONFIG = configPath;
  t.after(() => { if (previousConfig === undefined) delete process.env.PI_OPENAI_TOOLKIT_CONFIG; else process.env.PI_OPENAI_TOOLKIT_CONFIG = previousConfig; });
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, defaults: {
    remoteCompaction: { enabled: true, models: ['fixture-provider/fixture-model'] },
  } }));
  const file = join(cwd, 'evidence.txt');
  await writeFile(file, 'A'.repeat(3000) + '\nCRITICAL_EVIDENCE_AT_END');
  const http = createServer();
  const requests = [];
  let generation = 0, responseId = 0, sendTool = true, failCompact = false;
  function eventsFor(payload) {
    const compacting = payload.input?.some(item => item.type === 'compaction_trigger');
    requests.push({ payload, compacting });
    if (compacting) {
      if (failCompact) return [{ type: 'response.failed', response: { status: 'failed', error: { message: 'private failure' } } }];
      return [completed([{ ...checkpoint, id: `cmp_${++generation}`, encrypted_content: `opaque_fixture_${generation}` }])];
    }
    const id = `resp_${++responseId}`;
    if (sendTool) {
      sendTool = false;
      const item = { type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'read', arguments: JSON.stringify({ path: file }), status: 'completed' };
      return [
        { type: 'response.created', response: { id } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
      ];
    }
    const item = { type: 'message', id: `msg_${responseId}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture task complete.', annotations: [] }] };
    return [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'Fixture task complete.' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
    ];
  }
  http.on('request', async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const events = eventsFor(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(eventFrame).join(''));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => http.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${http.address().port}/v1`;
  await writeFile(join(cwd, 'models.json'), JSON.stringify({ providers: {
    'fixture-provider': { api: 'openai-responses', baseUrl, apiKey: 'fixture-only', models: [{ id: 'fixture-model', reasoning: false, contextWindow: 100000, maxTokens: 1000 }, { id: 'other-model', reasoning: false }] },
    'foreign-provider': { api: 'openai-responses', baseUrl, apiKey: 'fixture-only', models: [{ id: 'foreign-model', reasoning: false }] },
  } }));
  const host = dirname(findPackageJSON('@earendil-works/pi-coding-agent', pathToFileURL(__filename)));
  const sdk = await import(pathToFileURL(join(host, 'dist/index.js')).href);
  const { loadExtensions } = await import(pathToFileURL(join(host, 'dist/core/extensions/loader.js')).href);
  const { AuthStorage } = await import(pathToFileURL(join(host, 'dist/core/auth-storage.js')).href);
  const extensionPath = process.env.PI_OPENAI_TOOLKIT_TEST_EXTENSION ?? join(__dirname, 'index.ts');
  let session, activeExtension;
  async function open(manager) {
    const loaded = await loadExtensions([extensionPath], cwd);
    assert.deepEqual(loaded.errors, []);
    activeExtension = loaded.extensions[0];
    const modelRuntime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: join(cwd, 'models.json'), allowModelNetwork: false });
    const settingsManager = sdk.SettingsManager.inMemory({ transport: 'auto', compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1000 }, retry: { enabled: false }, cacheWarming: 'off' });
    const resourceLoader = {
      getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => 'Synthetic fixture. Preserve public APIs.', getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
    };
    ({ session } = await sdk.createAgentSession({ cwd, agentDir: cwd, modelRuntime, model: modelRuntime.getModel('fixture-provider', 'fixture-model'), thinkingLevel: 'off', tools: ['read'], sessionManager: manager, settingsManager, resourceLoader }));
    await session.bindExtensions({ abortHandler: () => { void session.abort(); } });
    return modelRuntime;
  }
  const manager = sdk.SessionManager.create(cwd, join(cwd, 'sessions'));
  t.after(() => session?.dispose());
  await open(manager);
  await session.prompt('Read the evidence and preserve its final line.');
  assert.equal(session.getLastAssistantText(), 'Fixture task complete.');
  const initialUser = manager.getBranch().find(entry => entry.message?.role === 'user');
  manager.appendContextEdit(initialUser.id, { content: [{ type: 'text', text: 'EDITED_SYNTHETIC_REQUEST' }] });
  const first = await session.compact();
  assert.ok(first.summary.startsWith(MARKER_PREFIX));
  const firstRequest = requests.find(item => item.compacting).payload;
  assert.ok(firstRequest.input.some(item => item.type === 'function_call_output' && item.output.includes('CRITICAL_EVIDENCE_AT_END')));
  assert.equal(firstRequest.input.filter(item => item.type === 'compaction_trigger').length, 1);
  assert.ok(JSON.stringify(firstRequest).includes('EDITED_SYNTHETIC_REQUEST'));
  assert.equal(JSON.stringify(firstRequest).includes('Read the evidence and preserve its final line.'), false);
  assert.equal(firstRequest.input.some(item => JSON.stringify(item).includes(MARKER_PREFIX)), false);
  assert.equal(first.usage.totalTokens, 24);
  const path = manager.getSessionFile();
  session.dispose();
  const reopenedManager = sdk.SessionManager.open(path);
  const modelRuntime = await open(reopenedManager);
  await session.prompt('Continue after reopening.');
  const replay = requests.filter(item => !item.compacting).at(-1).payload;
  assert.equal(replay.input.filter(item => item.type === 'compaction').length, 1);
  assert.ok(replay.tools.some(tool => tool.name === 'read'));
  assert.equal(JSON.stringify(replay).includes(MARKER_PREFIX), false);
  await session.compact();
  const recursive = requests.filter(item => item.compacting).at(-1).payload;
  assert.equal(recursive.input.filter(item => item.type === 'compaction').length, 1);
  assert.equal(recursive.input.filter(item => item.type === 'compaction_trigger').length, 1);
  assert.equal(recursive.input.some(item => item.type === 'function_call_output'), false, 'sealed evidence must not be duplicated');
  await session.prompt('Another milestone.');
  failCompact = true;
  const countBeforeFailure = reopenedManager.getBranch().filter(entry => entry.type === 'compaction').length;
  await assert.rejects(session.compact());
  assert.equal(reopenedManager.getBranch().filter(entry => entry.type === 'compaction').length, countBeforeFailure);
  failCompact = false;
  // A later payload hook cannot silently discard the replayed checkpoint.
  const handlers = activeExtension.handlers.get('before_provider_request');
  handlers.push(event => ({ ...event.payload, input: event.payload.input.filter(item => item.type !== 'compaction') }));
  const beforeHook = requests.length;
  await session.prompt('Attempt continuation after a destructive payload hook.');
  assert.equal(requests.length, beforeHook);
  handlers.pop();
  // A foreign model must not receive an opaque placeholder or make any request.
  await session.setModel(modelRuntime.getModel('foreign-provider', 'foreign-model'));
  const beforeForeign = requests.length;
  await session.prompt('Attempt a foreign-model continuation.');
  assert.equal(requests.length, beforeForeign);
  await session.setModel(modelRuntime.getModel('fixture-provider', 'fixture-model'));
  // Disabling generation still replays an inherited checkpoint after reload.
  const disabledConfig = JSON.parse(await require('node:fs/promises').readFile(configPath, 'utf8'));
  disabledConfig.defaults.remoteCompaction.enabled = false;
  await writeFile(configPath, JSON.stringify(disabledConfig));
  session.dispose();
  await open(reopenedManager);
  const beforeDisabled = requests.length;
  await session.prompt('Continue with generation disabled.');
  assert.equal(requests.length, beforeDisabled + 1);
  assert.equal(requests.at(-1).payload.input.filter(item => item.type === 'compaction').length, 1);
  await assert.rejects(session.compact());
  assert.equal(requests.length, beforeDisabled + 1);
  const latest = reopenedManager.getBranch().filter(entry => entry.type === 'compaction').at(-1);
  const sealed = latest.details.piOpenAICompaction.sealedEntryIds.find(id => reopenedManager.getEntry(id)?.message?.role === 'user');
  reopenedManager.appendContextEdit(sealed, null);
  const beforeEdit = requests.length;
  await session.prompt('Attempt continuation after editing sealed history.');
  assert.equal(requests.length, beforeEdit);
  await assert.rejects(session.compact());
  assert.equal(requests.length, beforeEdit);
});
