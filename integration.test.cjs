'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { findPackageJSON } = require('node:module');
const { createServer } = require('node:http');
const { spawnSync } = require('node:child_process');

// Exercise the installed Pi runtime without contacting a provider or using keys.
test('Pi loads/reloads Toolkit, preserves provider metadata, delegates SSE and executes imagegen', async t => {
  const host = dirname(findPackageJSON('@earendil-works/pi-coding-agent', pathToFileURL(__filename)));
  const cwd = await mkdtemp(join(tmpdir(), 'pi-toolkit-integration-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const previousConfigPath = process.env.PI_OPENAI_TOOLKIT_CONFIG;
  t.after(() => {
    if (previousConfigPath === undefined) delete process.env.PI_OPENAI_TOOLKIT_CONFIG;
    else process.env.PI_OPENAI_TOOLKIT_CONFIG = previousConfigPath;
  });
  process.env.PI_OPENAI_TOOLKIT_CONFIG = join(cwd, 'config.json');
  await writeFile(process.env.PI_OPENAI_TOOLKIT_CONFIG, JSON.stringify({ schemaVersion: 2, defaults: {
    remoteCompaction: { enabled: true, models: ['fixture-provider/gpt-5.4'] },
    imageGeneration: { enabled: true },
  } }));
  const originalArgv = process.argv[1];
  const extensionPath = process.env.PI_OPENAI_TOOLKIT_TEST_EXTENSION ?? join(__dirname, 'index.ts');
  const { loadExtensions } = await import(pathToFileURL(join(host, 'dist/core/extensions/loader.js')).href);
  const loaded = await loadExtensions([extensionPath], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  const registration = loaded.runtime.pendingProviderRegistrations.find(item => item.name === 'fixture-provider');
  assert.ok(registration);
  assert.equal(loaded.runtime.pendingProviderRegistrations.length, 1, 'only checkpoint providers are wrapped');
  for (const key of ['models', 'baseUrl', 'headers', 'apiKey']) assert.equal(registration.config[key], undefined);
  assert.ok(extension.tools.has('imagegen'));
  assert.ok(extension.commands.has('toolkit-config'));
  assert.equal(process.argv[1], originalArgv);
  assert.equal(extension.handlers.has('before_agent_start'), false);
  assert.equal(extension.handlers.has('agent_settled'), false);
  const requests = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/v1/responses');
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const id = `resp_${requests.length}`;
    const item = { type: 'message', id: `msg_${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'OK' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-fixture': 'sse' });
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.on('upgrade', () => assert.fail('Toolkit must not initiate a WebSocket upgrade'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({}, {});
    await new Promise(resolve => server.close(resolve));
  });
  const model = { id: 'gpt-5.4', name: 'Fixture', provider: 'fixture-provider', api: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const user = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 });
  let payloadHooks = 0, providerEvents = 0, fetchCalls = 0;
  const headers = [];
  const options = {
    apiKey: 'integration-fixture-only', sessionId: 'integration', transport: 'auto',
    onPayload: payload => { payloadHooks++; return { ...payload, metadata: { fixture: 'preserved' } }; },
    onResponse: value => { headers.push(value.headers); },
    onProviderStreamEvent: () => { providerEvents++; },
    fetch: (...args) => { fetchCalls++; return globalThis.fetch(...args); },
  };
  const first = await registration.config.streamSimple(model, { messages: [user('one')] }, options).result();
  assert.equal(first.stopReason, 'stop');
  assert.equal(first.content[0].text, 'OK');
  assert.equal(first.usage.totalTokens, 3);
  const second = await registration.config.streamSimple(model, { messages: [user('one'), first, user('two')] }, options).result();
  assert.equal(second.stopReason, 'stop');
  assert.equal(requests[1].previous_response_id, undefined);
  assert.ok(requests[1].input.length > requests[0].input.length, 'full history is delegated to Pi');
  assert.deepEqual(requests[1].metadata, { fixture: 'preserved' });
  assert.equal(payloadHooks, 2);
  assert.equal(providerEvents, 10);
  assert.equal(fetchCalls, 2);
  assert.equal(headers[1]['x-fixture'], 'sse');

  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://image-fixture.test/v1/images/generations');
    assert.equal(init.headers.get('authorization'), 'Bearer resolved-fixture-only');
    return new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=' }] }));
  };
  const result = await extension.tools.get('imagegen').definition.execute('fixture', { prompt: 'A test image', outputPath: 'test.png' }, undefined, undefined, {
    cwd, model, modelRegistry: { getApiKeyAndHeaders: async selected => {
      assert.equal(selected, model);
      return { ok: true, apiKey: 'resolved-fixture-only', baseUrl: 'https://image-fixture.test/v1' };
    } },
  });
  assert.equal(result.structuredContent.provider, 'fixture-provider');
  assert.equal(result.structuredContent.artifacts[0].path, join(cwd, 'test.png'));
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.isError, undefined);

  const reloaded = await loadExtensions([extensionPath], process.cwd());
  assert.deepEqual(reloaded.errors, []);
  assert.deepEqual([...reloaded.extensions[0].tools.keys()], ['imagegen']);
  for (const handler of reloaded.extensions[0].handlers.get('session_shutdown') ?? []) await handler({}, {});

  // Changing the config and reloading withdraws only this extension's features.
  await writeFile(process.env.PI_OPENAI_TOOLKIT_CONFIG, JSON.stringify({ schemaVersion: 2, defaults: {} }));
  const disabled = await loadExtensions([extensionPath], process.cwd());
  assert.deepEqual(disabled.errors, []);
  assert.deepEqual([...disabled.extensions[0].tools.keys()], []);
  assert.deepEqual(disabled.runtime.pendingProviderRegistrations, []);
});

test('bundled Node CLI loads Toolkit without transport helpers', async t => {
  const host = dirname(findPackageJSON('@earendil-works/pi-coding-agent', pathToFileURL(__filename)));
  const cwd = await mkdtemp(join(tmpdir(), 'pi-toolkit-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configPath = join(cwd, 'pi-openai-toolkit.json');
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, defaults: {
    remoteCompaction: { enabled: true, models: ['fixture-provider/fixture-model'] },
    imageGeneration: { enabled: true },
  } }));
  await writeFile(join(cwd, 'models.json'), JSON.stringify({ providers: {
    'fixture-provider': { api: 'openai-responses', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-fixture-only', models: [{ id: 'fixture-model' }] },
  } }));
  const extensionPath = process.env.PI_OPENAI_TOOLKIT_TEST_EXTENSION ?? join(__dirname, 'index.ts');
  const env = { ...process.env, PI_CODING_AGENT_DIR: cwd, PI_OFFLINE: '1' };
  delete env.PI_OPENAI_TOOLKIT_CONFIG;
  const child = spawnSync(process.execPath, [join(host, 'dist/bundle/cli.js'),
    '--offline', '--no-session', '--no-extensions', '-e', extensionPath,
    '--no-skills', '--no-context-files', '--provider', 'fixture-provider', '--model', 'fixture-model',
    '-p', '/toolkit-config validate',
  ], {
    cwd, encoding: 'utf8', timeout: 15_000,
    env,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.doesNotMatch(child.stderr, /Failed to load extension/);
});
