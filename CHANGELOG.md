# Changelog

## 0.2.0

- Remove the Responses WebSocket transport, connection reuse/continuation helpers, fallback tracking, transport status and related regression suites.
- Remove `ws` and `@types/ws` as direct dependencies.
- Remove `defaults.responsesWebSocket`; existing configurations must delete that section before upgrading.
- Preserve image generation and V2 remote compaction, delegating Responses requests and caller instrumentation to Pi.
- Keep checkpoint persistence, recursive compaction and replay safety coverage through offline HTTP/SSE integration tests.

## 0.1.2

- Normalize temporary WebSocket transport failures for Pi-managed retries; keep sent requests from being replayed inside fetch.
- Switch subsequent auto attempts to sticky session/route-scoped SSE after two consecutive transport failures, without resetting Pi retry limits.
- Add independent elapsed/progress status, cancellation-safe cleanup and bounded sanitized transport diagnostics outside model context.
- Limit connection age to 55 minutes and add a no-reuse diagnostic option.
- Exercise actual Pi retry scheduling and later-turn SSE recovery through offline regression tests.
- Add opt-in V2 remote compaction for exact `openai-responses` provider/model identities.
- Persist and replay opaque checkpoints through SSE and WebSocket while retaining Pi's recent-message boundary.
- Preserve full prefix tool outputs and persisted context edits; guard incomplete streams, unsafe replay, sealed-history edits and incompatible model switches.
- Add offline real-Pi persistence/reopen/recursive-compaction regression coverage.

## 0.1.1

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
