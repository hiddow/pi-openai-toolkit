'use strict';
const { readFileSync } = require('node:fs');
const { findPackageJSON } = require('node:module');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const TESTED_REPLAY_VERSION = '1.1.0';

function assertReplayVersion(version) {
  if (version !== TESTED_REPLAY_VERSION) {
    throw new Error(`Toolkit cached WebSocket is tested with Pi AI ${TESTED_REPLAY_VERSION}, not ${version}. Set responsesWebSocket.cachedContext to false for full-history WebSocket, or use the tested Pi release.`);
  }
}

/** Resolve through Pi's public package directory, not its CLI entry or extension peers. */
async function loadReplayHelpers(hostPackageDirectory) {
  const packageFile = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(join(hostPackageDirectory, 'package.json')));
  if (!packageFile) throw new Error('Cannot locate host Pi AI. Set responsesWebSocket.cachedContext to false.');
  const compatEntryUrl = pathToFileURL(join(dirname(packageFile), 'dist', 'compat.js'));
  const { version } = JSON.parse(readFileSync(packageFile, 'utf8'));
  assertReplayVersion(version);
  const [responses, grammar, transcript] = await Promise.all([
    import(new URL('./api/openai-responses-shared.js', compatEntryUrl).href),
    import(new URL('./api/constrained-sampling.js', compatEntryUrl).href),
    import(new URL('./utils/transcript.js', compatEntryUrl).href),
  ]);
  const helpers = {
    convertResponsesMessages: responses.convertResponsesMessages,
    createGrammarToolInputProperties: grammar.createGrammarToolInputProperties,
    getDeclaredTools: transcript.getDeclaredTools,
  };
  if (!Object.values(helpers).every(value => typeof value === 'function')) {
    throw new Error('Toolkit cannot load Pi replay helpers. Set responsesWebSocket.cachedContext to false.');
  }
  return helpers;
}
module.exports = { loadReplayHelpers, assertReplayVersion, TESTED_REPLAY_VERSION };
