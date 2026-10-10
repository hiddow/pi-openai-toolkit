'use strict';
const { open, mkdir, unlink } = require('node:fs/promises');
const { dirname, resolve } = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'];
const QUALITIES = ['auto', 'low', 'medium', 'high'];
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function imageMimeType(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND') return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'image/jpeg';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return 'image/webp';
}
function normalizeParams(params, config) {
  const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
  if (!prompt || prompt.length > 32_000) throw new Error('Image prompt must contain 1–32000 characters.');
  const model = params.model ?? config.defaultModel;
  if (!config.allowedModels.includes(model)) throw new Error(`Image model must be one of: ${config.allowedModels.join(', ')}.`);
  const size = params.size ?? 'auto';
  const quality = params.quality ?? 'auto';
  if (!SIZES.includes(size) || !QUALITIES.includes(quality)) throw new Error('Unsupported image size or quality.');
  const batchSize = params.batchSize ?? 1;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) throw new Error('Image batchSize must be an integer from 1 to 10.');
  const referenceImagePaths = params.referenceImagePaths ?? [];
  if (!Array.isArray(referenceImagePaths) || referenceImagePaths.length > 16 || !referenceImagePaths.every(path => typeof path === 'string' && path.trim())) throw new Error('Provide at most 16 local reference image paths.');
  if (params.outputPath !== undefined && (typeof params.outputPath !== 'string' || !params.outputPath.trim() || !params.outputPath.toLowerCase().endsWith('.png'))) throw new Error('Image outputPath must end in .png.');
  if (params.outputPath && batchSize > 1) throw new Error('outputPath is only supported for a single image.');
  return { prompt, model, size, quality, batchSize, referenceImagePaths, outputPath: params.outputPath };
}
function buildEndpoint(baseUrl, edit) {
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Image generation requires a plain HTTP(S) provider base URL.');
  const basePath = url.pathname.replace(/\/+$/, '');
  if (basePath.endsWith('/responses')) throw new Error('Configure the provider base URL, not a /responses endpoint, for image generation.');
  url.pathname = `${basePath}/images/${edit ? 'edits' : 'generations'}`;
  return url.href;
}
function buildHeaders(runtime, multipart) {
  const headers = new Headers();
  for (const source of [runtime.modelHeaders, runtime.headers]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (value === null) headers.delete(name);
      else if (typeof value === 'string') headers.set(name, value);
    }
  }
  if (!headers.has('authorization') && runtime.apiKey) headers.set('authorization', `Bearer ${runtime.apiKey}`);
  // Custom gateway authentication headers are also supported, as resolved by Pi.
  headers.set('accept', 'application/json');
  headers.delete('content-length');
  if (multipart) headers.delete('content-type');
  else headers.set('content-type', 'application/json');
  return headers;
}
async function readReferences(paths, cwd, signal) {
  const references = [];
  let total = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const handle = await open(resolve(cwd, path), 'r');
    try {
      const stat = await handle.stat();
      total += stat.size;
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES || total > 50 * 1024 * 1024) throw new Error('Reference images must be regular files, at most 32 MiB each and 50 MiB in total.');
      // Read at most the allowed size even if the file grows after stat().
      const bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw new Error('Reference image changed while reading; try again.');
      const image = bytes.subarray(0, bytesRead);
      const mimeType = imageMimeType(image);
      if (!mimeType) throw new Error('Reference images must be PNG, JPEG or WebP.');
      references.push({ bytes: image, mimeType });
    } finally { await handle.close(); }
  }
  return references;
}
function buildBody(params, references) {
  const common = { model: params.model, prompt: params.prompt, n: 1, size: params.size, output_format: 'png' };
  if (params.quality !== 'auto') common.quality = params.quality;
  // GPT Image returns base64 by default and rejects response_format.
  if (!references.length) return JSON.stringify(common);
  const form = new FormData();
  for (const [name, value] of Object.entries(common)) form.append(name, String(value));
  for (const [index, reference] of references.entries()) {
    const extension = reference.mimeType === 'image/jpeg' ? 'jpg' : reference.mimeType.slice(6);
    form.append(references.length === 1 ? 'image' : 'image[]', new Blob([reference.bytes], { type: reference.mimeType }), `reference-${index + 1}.${extension}`);
  }
  return form;
}
function diagnostic(message) { return Object.assign(new Error(message), { toolkitSafe: true }); }
async function readBoundedJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw diagnostic('Image response exceeds the 48 MiB limit.');
  }
  if (!response.body) throw diagnostic('Image API returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw diagnostic('Image response exceeds the 48 MiB limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { throw diagnostic('Image API returned invalid JSON.'); }
}
function parseImage(payload) {
  if (!Array.isArray(payload?.data) || payload.data.length !== 1) throw diagnostic('Image API must return exactly one base64 image per request.');
  const value = payload.data[0]?.b64_json;
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw diagnostic('Image API returned invalid or oversized base64 data; URL-only results are not supported.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value || imageMimeType(bytes) !== 'image/png') throw diagnostic('Image API did not return a valid PNG as requested.');
  return bytes;
}
function safeFailure(error, signal, timeout) {
  if (signal?.aborted) return 'Image generation cancelled; completed images were preserved.';
  if (timeout?.aborted) return 'Image generation timed out; the request was not retried.';
  // Only our own errors may contain diagnostic text; network/provider bodies can
  // contain credentials or reference data and are never included in tool results.
  return error.toolkitSafe ? error.message : 'Image generation failed; the request was not retried.';
}
async function requestImage(runtime, params, references, signal, config, fetchFn) {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const endpoint = buildEndpoint(runtime.baseUrl, references.length > 0);
  const headers = buildHeaders(runtime, references.length > 0);
  let response;
  try {
    response = await fetchFn(endpoint, { method: 'POST', headers, body: buildBody(params, references), signal: combined, redirect: 'error' });
  } catch (error) { throw new Error(safeFailure(error, signal, timeout)); }
  try {
    if (!response.ok) {
      await response.body?.cancel();
      throw diagnostic(`Image request rejected (HTTP ${response.status}); not retried. Check provider image support, credentials and quota.`);
    }
    return parseImage(await readBoundedJson(response));
  } catch (error) {
    if (signal?.aborted || timeout.aborted) throw new Error(safeFailure(error, signal, timeout));
    // The parser's fixed diagnostics do not include any server payload.
    if (error.toolkitSafe) throw error;
    throw new Error('Image response could not be read; the request was not retried.');
  }
}

async function generateImages({ runtime, params, config, cwd, signal, onImage, fetchFn = globalThis.fetch }) {
  if (!config.enabled) throw new Error('Toolkit image generation is disabled.');
  if (runtime.api !== 'openai-responses') throw new Error('imagegen requires an openai-responses provider with a working Images API.');
  const normalized = normalizeParams(params, config);
  buildEndpoint(runtime.baseUrl, normalized.referenceImagePaths.length > 0);
  signal?.throwIfAborted();
  const references = await readReferences(normalized.referenceImagePaths, cwd, signal);
  const reservations = [];
  const images = [];
  const artifacts = [];
  let error;
  try {
    // Reserve destinations before any paid request; never overwrite user files.
    for (let i = 0; i < normalized.batchSize; i++) {
      const path = normalized.outputPath
        ? resolve(cwd, normalized.outputPath)
        : resolve(cwd, config.artifactDirectory, `${randomUUID()}.png`);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      reservations.push({ path, handle: await open(path, 'wx', 0o600), committed: false });
    }
    for (const reservation of reservations) {
      signal?.throwIfAborted();
      const bytes = await requestImage(runtime, normalized, references, signal, config, fetchFn);
      await reservation.handle.writeFile(bytes);
      await reservation.handle.close();
      reservation.committed = true;
      artifacts.push({ path: reservation.path, mimeType: 'image/png', bytes: bytes.length });
      images.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' });
      onImage?.(artifacts.slice());
    }
  } catch (failure) {
    if (!artifacts.length && !reservations.length) throw failure;
    error = signal?.aborted ? 'Image generation cancelled; completed images were preserved.' : failure.message;
  } finally {
    for (const reservation of reservations) {
      if (!reservation.committed) {
        await reservation.handle.close().catch(() => {});
        await unlink(reservation.path).catch(() => {});
      }
    }
  }
  return { model: normalized.model, action: references.length ? 'edit' : 'generate', artifacts, images, ...(error ? { error } : {}) };
}
module.exports = { generateImages, normalizeParams, buildEndpoint, buildHeaders, parseImage };
