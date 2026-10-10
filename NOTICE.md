# Attribution

This independently maintained plugin evolved from a local `hiddow-websocket` extension. Its image-generation feature scope and schema-v2 configuration layout were informed by [awoaCrim/pi-openai-toolkit](https://github.com/awoaCrim/pi-openai-toolkit). It is not the upstream package, does not implement all upstream features, and is not affiliated with that project or OpenAI.

The WebSocket adapter delegates Responses message conversion and stream parsing to the host [Pi](https://github.com/earendil-works/pi) installation. No Pi implementation files are bundled. Cached replay currently depends on Pi AI 1.1.0 internals.

Runtime and development dependencies retain their own licenses.
