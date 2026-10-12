'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm, readFile, writeFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { generateImages, buildEndpoint, buildHeaders, parseImage } = require('./image-generation.cjs');
const { parseConfig } = require('./config.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=', 'base64');
const config = parseConfig({ schemaVersion: 2, defaults: { imageGeneration: { enabled: true } } }).imageGeneration;
const runtime = { api: 'openai-responses', baseUrl: 'https://fixture.test/v1', apiKey: 'test-fixture-only' };
const response = () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-toolkit-image-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, runtime, config, params: { prompt: 'A test image' } };
}

test('generates through the same provider, uses GPT Image fields and saves a private PNG', async t => {
  const f = await fixture(t);
  let calls = 0;
  const result = await generateImages({ ...f, fetchFn: async (url, options) => {
    calls++;
    assert.equal(url, 'https://fixture.test/v1/images/generations');
    assert.equal(options.headers.get('authorization'), 'Bearer test-fixture-only');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-image-1.5');
    assert.equal(body.n, 1);
    assert.equal(body.output_format, 'png');
    assert.equal(body.response_format, undefined);
    assert.equal(body.quality, undefined);
    return response();
  } });
  assert.equal(calls, 1);
  assert.equal(result.action, 'generate');
  assert.equal(result.error, undefined);
  assert.deepEqual(await readFile(result.artifacts[0].path), png);
  assert.equal(result.images[0].mimeType, 'image/png');
});

test('editing uploads only supplied local references using multipart with automatic boundary', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'source.png'), png);
  const result = await generateImages({ ...f, params: { ...f.params, referenceImagePaths: ['source.png'], quality: 'high' },
    runtime: { ...runtime, headers: { 'Content-Type': 'text/plain' } },
    fetchFn: async (url, options) => {
      assert.equal(url, 'https://fixture.test/v1/images/edits');
      assert.equal(options.headers.has('content-type'), false);
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get('quality'), 'high');
      assert.equal(options.body.get('image').type, 'image/png');
      assert.deepEqual(Buffer.from(await options.body.get('image').arrayBuffer()), png);
      return response();
    },
  });
  assert.equal(result.action, 'edit');
});

test('rejects unknown models, invalid references and existing output files before any paid request', async t => {
  const f = await fixture(t);
  const fetchFn = async () => assert.fail('unexpected paid dispatch');
  await assert.rejects(generateImages({ ...f, fetchFn, params: { ...f.params, model: 'not-allowed' } }), /must be one of/);
  await writeFile(join(f.cwd, 'secret.txt'), 'not an image');
  await assert.rejects(generateImages({ ...f, fetchFn, params: { ...f.params, referenceImagePaths: ['secret.txt'] } }), /must be PNG/);
  await writeFile(join(f.cwd, 'existing.png'), 'preserve me');
  await assert.rejects(generateImages({ ...f, fetchFn, params: { ...f.params, outputPath: 'existing.png' } }), /EEXIST/);
  assert.equal(await readFile(join(f.cwd, 'existing.png'), 'utf8'), 'preserve me');
});

test('partial batch failure preserves completed images and deletes unused reservations without retries', async t => {
  const f = await fixture(t);
  let calls = 0;
  const result = await generateImages({ ...f, params: { ...f.params, batchSize: 3 }, fetchFn: async () => ++calls === 1 ? response() : new Response('private upstream body', { status: 429 }) });
  assert.equal(calls, 2);
  assert.equal(result.artifacts.length, 1);
  assert.match(result.error, /HTTP 429/);
  assert.doesNotMatch(result.error, /private upstream/);
  assert.deepEqual(await readdir(join(f.cwd, config.artifactDirectory)), [result.artifacts[0].path.split('/').at(-1)]);
});

test('cancellation preserves earlier images and never dispatches the remaining batch', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let calls = 0;
  const result = await generateImages({ ...f, params: { ...f.params, batchSize: 2 }, signal: controller.signal,
    fetchFn: async () => { calls++; return response(); }, onImage: () => controller.abort(),
  });
  assert.equal(calls, 1);
  assert.equal(result.artifacts.length, 1);
  assert.match(result.error, /cancelled/);
});

test('network failures do not leak diagnostics or leave files behind', async t => {
  const f = await fixture(t);
  const result = await generateImages({ ...f, fetchFn: async () => { throw new Error('Bearer private-credential'); } });
  assert.match(result.error, /not retried/);
  assert.doesNotMatch(result.error, /private-credential/);
  assert.deepEqual(await readdir(join(f.cwd, config.artifactDirectory)), []);
});

test('malformed, URL-only and oversized responses fail closed', async t => {
  const f = await fixture(t);
  for (const value of [{ data: [{ url: 'https://untrusted.test/image.png' }] }, { data: [{ b64_json: Buffer.from('not a PNG').toString('base64') }] }]) {
    const result = await generateImages({ ...f, fetchFn: async () => new Response(JSON.stringify(value)) });
    assert.ok(result.error);
    assert.equal(result.artifacts.length, 0);
  }
  const result = await generateImages({ ...f, fetchFn: async () => new Response('{}', { headers: { 'content-length': String(49 * 1024 * 1024) } }) });
  assert.match(result.error, /48 MiB/);
  assert.throws(() => parseImage({ data: [{ b64_json: '!!!!' }] }), /invalid/);
});

test('header precedence, explicit removals and endpoint validation preserve routing boundaries', () => {
  const headers = buildHeaders({ apiKey: 'fixture', modelHeaders: { Authorization: 'Bearer old', 'X-Route': 'old' }, headers: { authorization: 'Bearer resolved', 'x-route': null } }, false);
  assert.equal(headers.get('authorization'), 'Bearer resolved');
  assert.equal(headers.has('x-route'), false);
  assert.equal(buildEndpoint('https://fixture.test/custom/v1/', false), 'https://fixture.test/custom/v1/images/generations');
  for (const base of ['https://fixture.test/v1/responses', 'https://user:secret@fixture.test/v1', 'https://fixture.test/v1?key=private']) assert.throws(() => buildEndpoint(base, false));
});

test('Toolkit config validates allowlists and rejects unsupported upstream features', () => {
  assert.throws(() => parseConfig({ schemaVersion: 2, defaults: { imageGeneration: { defaultModel: 'other' } } }), /included/);
  assert.throws(() => parseConfig({ schemaVersion: 2, defaults: { imageGeneration: { enabled: 'true' } } }), /boolean/);
  assert.throws(() => parseConfig({ schemaVersion: 2, defaults: { context: { mode: 'remote-compaction' } } }), /Unsupported/);
  assert.throws(() => parseConfig({ schemaVersion: 2, defaults: { imageGeneration: { timeoutMs: 0 } } }), /timeoutMs/);
});
