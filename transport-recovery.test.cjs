'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { findPackageJSON } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const { WebSocketServer } = require('ws');

test('Pi schedules bounded WS retries and the bridge keeps later turns on SSE', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-transport-recovery-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configPath = join(cwd, 'toolkit.json');
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, defaults: { responsesWebSocket: { enabled: true, providers: ['recovery-fixture'] } } }));
  const previous = process.env.PI_OPENAI_TOOLKIT_CONFIG;
  process.env.PI_OPENAI_TOOLKIT_CONFIG = configPath;
  t.after(() => { if (previous === undefined) delete process.env.PI_OPENAI_TOOLKIT_CONFIG; else process.env.PI_OPENAI_TOOLKIT_CONFIG = previous; });
  let websocketAttempts = 0;
  let httpAttempts = 0;
  const http = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); httpAttempts++;
    assert.equal(body.previous_response_id, undefined);
    const item = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Recovered offline.', annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id: `http_${httpAttempts}` } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'Recovered offline.' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `http_${httpAttempts}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  const websocket = new WebSocketServer({ server: http });
  websocket.on('connection', socket => socket.on('message', () => { websocketAttempts++; socket.terminate(); }));
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of websocket.clients) client.terminate(); await new Promise(resolve => websocket.close(resolve)); await new Promise(resolve => http.close(resolve)); });
  await writeFile(join(cwd, 'models.json'), JSON.stringify({ providers: { 'recovery-fixture': {
    api: 'openai-responses', baseUrl: `http://127.0.0.1:${http.address().port}/v1`, apiKey: 'fixture-only',
    models: [{ id: 'fixture-model', reasoning: false, contextWindow: 100000, maxTokens: 1000 }],
  } } }));
  const host = dirname(findPackageJSON('@earendil-works/pi-coding-agent', pathToFileURL(__filename)));
  const sdk = await import(pathToFileURL(join(host, 'dist/index.js')).href);
  const { loadExtensions } = await import(pathToFileURL(join(host, 'dist/core/extensions/loader.js')).href);
  const { AuthStorage } = await import(pathToFileURL(join(host, 'dist/core/auth-storage.js')).href);
  const loaded = await loadExtensions([process.env.PI_OPENAI_TOOLKIT_TEST_EXTENSION ?? join(__dirname, 'index.ts')], cwd);
  assert.deepEqual(loaded.errors, []);
  const modelRuntime = await sdk.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: join(cwd, 'models.json'), allowModelNetwork: false });
  const manager = sdk.SessionManager.create(cwd, join(cwd, 'sessions'));
  const resourceLoader = {
    getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => 'Offline recovery fixture.', getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
  };
  const { session } = await sdk.createAgentSession({ cwd, agentDir: cwd, modelRuntime, model: modelRuntime.getModel('recovery-fixture', 'fixture-model'), thinkingLevel: 'off', tools: [], sessionManager: manager, resourceLoader,
    settingsManager: sdk.SettingsManager.inMemory({ transport: 'auto', compaction: { enabled: false }, retry: { enabled: true, maxRetries: 5, baseDelayMs: 1, maxAgentDelayMs: 5 }, cacheWarming: 'off' }),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ abortHandler: () => { void session.abort(); } });
  const retryEvents = [];
  session.subscribe(event => { if (event.type === 'auto_retry_start') retryEvents.push(event); });
  await session.prompt('First synthetic turn.'); await session.waitForIdle();
  assert.equal(session.getLastAssistantText(), 'Recovered offline.');
  assert.equal(retryEvents.length, 2);
  assert.equal(websocketAttempts, 2);
  assert.equal(httpAttempts, 1);
  await session.prompt('Later synthetic turn.'); await session.waitForIdle();
  assert.equal(websocketAttempts, 2);
  assert.equal(httpAttempts, 2);
  const diagnostic = manager.getBranch().find(entry => entry.type === 'custom' && entry.customType === 'pi-openai-transport');
  assert.equal(diagnostic.data.outcome, 'stop');
  assert.doesNotMatch(JSON.stringify(diagnostic.data), /fixture-only|synthetic turn|Bearer|127\.0\.0\.1/);
});
