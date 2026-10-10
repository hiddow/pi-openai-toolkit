# Changelog

## 0.1.1 (not yet published to npm)

- Add the unscoped npm package `pi-openai-bridge` with public npm registry settings and pre-publish checks.
- Preserve the existing configuration path, environment variable, command and tool names.
- Keep the GitHub source repository and the published v0.1.0 Git tag unchanged.

## 0.1.0

- Responses WebSocket with session reuse, incremental replay and pre-send SSE fallback.
- `imagegen` for generation, reference-image editing and separately dispatched batches.
- External schema-v2 configuration at `<agent-dir>/pi-openai-toolkit.json`, with explicit-path overrides, legacy-location fallback and safe opt-in defaults.
- Explicit `ws` dependency; CLI-independent Pi helper resolution.
- Optional full-history WebSocket mode and a Pi AI 1.1.0 guard for cached replay.
- Portable offline tests, TypeScript checks, package lockfile and GitHub Actions configuration.
