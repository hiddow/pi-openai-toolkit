'use strict';
const { readFileSync, statSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');

const DEFAULTS = {
  responsesWebSocket: { enabled: false, providers: [], cachedContext: true },
  imageGeneration: {
    enabled: false,
    defaultModel: 'gpt-image-1.5',
    allowedModels: ['gpt-image-1.5', 'gpt-image-2'],
    timeoutMs: 300_000,
    artifactDirectory: '.pi/generated-images',
  },
};
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function parseConfig(value) {
  if (!record(value) || value.schemaVersion !== 2 || !record(value.defaults)) {
    throw new Error('Toolkit config requires schemaVersion: 2 and a defaults object.');
  }
  for (const key of Object.keys(value)) if (!['schemaVersion', 'defaults'].includes(key)) throw new Error(`Unsupported Toolkit config field: ${key}`);
  for (const key of Object.keys(value.defaults)) if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`Unsupported Toolkit defaults field: ${key}`);
  const result = structuredClone(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) {
    const section = value.defaults[key];
    if (section === undefined) continue;
    if (!record(section)) throw new Error(`Toolkit ${key} must be an object.`);
    for (const field of Object.keys(section)) if (!Object.hasOwn(DEFAULTS[key], field)) throw new Error(`Unsupported Toolkit ${key} field: ${field}`);
    Object.assign(result[key], section);
  }
  const ws = result.responsesWebSocket;
  const images = result.imageGeneration;
  for (const section of [ws, images]) if (typeof section.enabled !== 'boolean') throw new Error('Toolkit enabled must be boolean.');
  if (typeof ws.cachedContext !== 'boolean') throw new Error('Toolkit cachedContext must be boolean.');
  for (const list of [ws.providers, images.allowedModels]) {
    if (!Array.isArray(list) || !list.every(item => typeof item === 'string' && item.trim() === item && item.length > 0 && item.length <= 256)) {
      throw new Error('Toolkit providers and allowedModels must be arrays of model/provider IDs.');
    }
  }
  if (ws.enabled && !ws.providers.length) throw new Error('Enable WebSocket only after configuring a nonempty providers list.');
  if (!images.allowedModels.length) throw new Error('Toolkit allowedModels must be nonempty.');
  if (!images.allowedModels.includes(images.defaultModel)) throw new Error('Toolkit defaultModel must be included in allowedModels.');
  if (!Number.isSafeInteger(images.timeoutMs) || images.timeoutMs < 1000 || images.timeoutMs > 3_600_000) throw new Error('Toolkit timeoutMs must be 1000–3600000.');
  if (typeof images.artifactDirectory !== 'string' || !images.artifactDirectory.trim()) throw new Error('Toolkit artifactDirectory must be a nonempty path.');
  return result;
}
function pathExists(path) {
  try { statSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function resolveConfigPath(agentDirectory, env = process.env) {
  const override = env.PI_OPENAI_TOOLKIT_CONFIG;
  if (override !== undefined) {
    if (typeof override !== 'string' || !override.trim() || !isAbsolute(override)) {
      throw new Error('PI_OPENAI_TOOLKIT_CONFIG must be an absolute config file path.');
    }
    return resolve(override);
  }
  const path = join(agentDirectory, 'pi-openai-toolkit.json');
  const legacyPath = join(agentDirectory, 'extensions', 'pi-openai-toolkit', 'config.json');
  // Prefer the agent-root file. Never hide invalid or inaccessible new configs
  // by switching to a different file; legacy fallback is only for absence.
  return pathExists(path) || !pathExists(legacyPath) ? path : legacyPath;
}
function loadConfigFile(path, required = false) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' && !required) return structuredClone(DEFAULTS); throw error; }
  return parseConfig(JSON.parse(text));
}
function loadConfig(directory) { return loadConfigFile(join(directory, 'config.json')); }
module.exports = { loadConfig, loadConfigFile, parseConfig, resolveConfigPath };
