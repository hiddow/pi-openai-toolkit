'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { parseConfig, loadConfigFile, resolveConfigPath } = require('./config.cjs');
const { assertReplayVersion } = require('./pi-runtime.cjs');

test('a missing default config disables optional features and has no personal provider', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-toolkit-config-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = loadConfigFile(join(cwd, 'missing.json'));
  assert.equal(config.responsesWebSocket.enabled, false);
  assert.deepEqual(config.responsesWebSocket.providers, []);
  assert.equal(config.imageGeneration.enabled, false);
});

test('explicit config paths are absolute and missing overrides fail instead of selecting defaults', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-toolkit-config-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'custom.json');
  assert.equal(resolveConfigPath(cwd, {}), join(cwd, 'pi-openai-toolkit.json'));
  assert.equal(resolveConfigPath(cwd, { PI_OPENAI_TOOLKIT_CONFIG: path }), path);
  for (const value of ['', 'config.json']) assert.throws(() => resolveConfigPath(cwd, { PI_OPENAI_TOOLKIT_CONFIG: value }), /absolute/);
  assert.throws(() => loadConfigFile(path, true), /ENOENT/);
  await writeFile(path, JSON.stringify({ schemaVersion: 2, defaults: { imageGeneration: { enabled: true } } }));
  assert.equal(loadConfigFile(path, true).imageGeneration.enabled, true);
});

test('agent-root config takes precedence over legacy config without merging their settings', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-toolkit-config-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const legacy = join(cwd, 'extensions/pi-openai-toolkit/config.json');
  const current = join(cwd, 'pi-openai-toolkit.json');
  await mkdir(join(cwd, 'extensions/pi-openai-toolkit'), { recursive: true });
  await writeFile(legacy, JSON.stringify({ schemaVersion: 2, defaults: { responsesWebSocket: { enabled: true, providers: ['legacy-fixture'] } } }));
  assert.equal(resolveConfigPath(cwd, {}), legacy);
  assert.equal(loadConfigFile(resolveConfigPath(cwd, {})).responsesWebSocket.enabled, true);
  await writeFile(current, JSON.stringify({ schemaVersion: 2, defaults: { imageGeneration: { enabled: true } } }));
  assert.equal(resolveConfigPath(cwd, {}), current);
  const config = loadConfigFile(resolveConfigPath(cwd, {}));
  assert.equal(config.imageGeneration.enabled, true);
  assert.equal(config.responsesWebSocket.enabled, false);
  assert.deepEqual(config.responsesWebSocket.providers, []);
});

test('explicit overrides win even when both default locations exist, and missing overrides fail', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-toolkit-config-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const legacy = join(cwd, 'extensions/pi-openai-toolkit/config.json');
  await mkdir(join(cwd, 'extensions/pi-openai-toolkit'), { recursive: true });
  const body = JSON.stringify({ schemaVersion: 2, defaults: {} });
  await writeFile(legacy, body);
  await writeFile(join(cwd, 'pi-openai-toolkit.json'), body);
  const override = join(cwd, 'override.json');
  await writeFile(override, body);
  assert.equal(resolveConfigPath(cwd, { PI_OPENAI_TOOLKIT_CONFIG: override }), override);
  const missing = join(cwd, 'missing-override.json');
  assert.equal(resolveConfigPath(cwd, { PI_OPENAI_TOOLKIT_CONFIG: missing }), missing);
  assert.throws(() => loadConfigFile(missing, true), /ENOENT/);
});

test('an invalid agent-root config fails rather than silently loading a valid legacy file', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-toolkit-config-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const legacy = join(cwd, 'extensions/pi-openai-toolkit/config.json');
  const current = join(cwd, 'pi-openai-toolkit.json');
  await mkdir(join(cwd, 'extensions/pi-openai-toolkit'), { recursive: true });
  await writeFile(legacy, JSON.stringify({ schemaVersion: 2, defaults: {} }));
  await writeFile(current, '{');
  assert.equal(resolveConfigPath(cwd, {}), current);
  assert.throws(() => loadConfigFile(resolveConfigPath(cwd, {})), SyntaxError);
});

test('WebSocket requires a provider and cached context can be disabled independently', () => {
  assert.throws(() => parseConfig({ schemaVersion: 2, defaults: { responsesWebSocket: { enabled: true } } }), /nonempty providers/);
  const config = parseConfig({ schemaVersion: 2, defaults: { responsesWebSocket: { enabled: true, providers: ['fixture'], cachedContext: false } } });
  assert.equal(config.responsesWebSocket.cachedContext, false);
  assert.equal(config.imageGeneration.enabled, false);
  assert.throws(() => parseConfig({ schemaVersion: 2, defaults: { responsesWebSocket: { cachedContext: 'false' } } }), /boolean/);
});

test('unknown and credential fields are rejected; image defaults must remain allowlisted', () => {
  assert.throws(() => parseConfig({ schemaVersion: 2, defaults: {}, apiKey: 'test-fixture-only' }), /Unsupported/);
  assert.throws(() => parseConfig({ schemaVersion: 2, defaults: { imageGeneration: { allowedModels: [] } } }), /nonempty/);
  assert.throws(() => parseConfig(JSON.parse('{"schemaVersion":2,"defaults":{"__proto__":{}}}')), /Unsupported/);
});

test('cached replay rejects unverified Pi versions with an actionable full-history alternative', () => {
  assert.doesNotThrow(() => assertReplayVersion('1.1.0'));
  assert.throws(() => assertReplayVersion('1.2.0'), /cachedContext to false/);
});
