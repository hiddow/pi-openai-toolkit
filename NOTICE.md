# Attribution

This independently maintained plugin evolved from a local `hiddow-websocket` extension. Its image-generation feature scope and schema-v2 configuration layout were informed by [awoaCrim/pi-openai-toolkit](https://github.com/awoaCrim/pi-openai-toolkit). It is not the upstream package, does not implement all upstream features, and is not affiliated with that project or OpenAI.

The WebSocket adapter delegates Responses message conversion and stream parsing to the host [Pi](https://github.com/earendil-works/pi) installation. No Pi implementation files are bundled. Cached replay currently depends on Pi AI 1.1.0 internals.

The V2 `compaction_trigger` protocol, terminal/checkpoint reconciliation rules, opaque checkpoint persistence/replay boundaries and sealed-history edit guards were adapted from [awoaCrim/pi-openai-toolkit](https://github.com/awoaCrim/pi-openai-toolkit), commit `9844924f82c21937cf3c54942cec5af0b57dab6d` (MIT, Copyright (c) 2026 lll9p). This implementation uses Pi's retained-prefix compaction boundary and public SDK conversion rather than importing the upstream runtime.

Runtime and development dependencies retain their own licenses.
