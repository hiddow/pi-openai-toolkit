# pi-openai-toolkit

## 功能和兼容范围

这是一个独立维护的 Pi 插件，提供 Responses WebSocket 和 `imagegen`。项目由本地 `hiddow-websocket` 扩展而来，参考了 [awoaCrim/pi-openai-toolkit](https://github.com/awoaCrim/pi-openai-toolkit) 的功能范围和配置结构。它不包含上游的上下文压缩和搜索功能，也不兼容完整的上游配置。

- Node.js：22.19.0 或更新版本。
- Pi：已验证 1.1.0 的 Node.js 发行版，包括 CLI 和 SDK 扩展加载。
- 增量 WebSocket：目前要求 Pi AI 1.1.0。其他版本需要先关闭 `cachedContext`，再验证完整历史 WebSocket；这不代表其他版本已经通过兼容测试。
- Bun 和嵌入式单文件发行版：未验证。增量模式需要读取宿主 Pi AI 的模块文件。

插件复用 Pi 的 provider、模型、端点、请求头和凭证。它不修改 `models.json`、`auth.json` 或模型列表。`ws` 是插件自己的运行时依赖，不从 CLI 启动路径借用。

## 安装和更新

项目仓库：[hiddow/pi-openai-toolkit](https://github.com/hiddow/pi-openai-toolkit)。指定标签可以固定版本：

```bash
pi install git:github.com/hiddow/pi-openai-toolkit@v0.1.0
```

如果希望跟随仓库默认分支更新，安装时不要指定标签：

```bash
pi install git:github.com/hiddow/pi-openai-toolkit
pi update --extensions
```

指定标签或提交的安装保持固定版本。升级到另一个标签时，重新安装对应来源。

本地开发也可以加载整个包：

```bash
npm ci --ignore-scripts
pi --no-extensions -e .
```

不要同时加载本项目和另一套注册 `imagegen` 或 `/toolkit-config` 的插件，包括上游同名项目。

## 外部配置

**无配置时，WebSocket 和图片工具默认关闭。** 默认配置文件直接放在 agent 根目录：

```text
~/.pi/agent/pi-openai-toolkit.json
```

设置了 `PI_CODING_AGENT_DIR` 时，插件使用该 agent directory。Git 安装位置与配置位置分开，更新插件不会覆盖个人配置。

从源码目录复制配置示例：

```bash
mkdir -p ~/.pi/agent
cp -n config.example.json ~/.pi/agent/pi-openai-toolkit.json
```

也可以指定另一个配置文件。环境变量必须是绝对路径，文件必须存在：

```bash
PI_OPENAI_TOOLKIT_CONFIG=/absolute/path/toolkit.json pi
```

读取优先级如下，不会合并不同文件的配置：

1. `PI_OPENAI_TOOLKIT_CONFIG` 指定的文件。
2. `<agent-dir>/pi-openai-toolkit.json`。
3. 旧路径 `<agent-dir>/extensions/pi-openai-toolkit/config.json`，仅在新文件不存在时兼容读取。
4. 两个默认路径都不存在时，使用关闭功能的默认配置。

指定文件不存在，或选中的配置无效时，插件报错，不会悄悄改用其他文件。

以下示例启用两个功能。把 `your-provider` 换成 Pi 中已经配置的 provider ID；图片模型也需要上游开放权限。**图片生成可能收费，参考图会上传到当前 provider。**

```json
{
  "schemaVersion": 2,
  "defaults": {
    "responsesWebSocket": {
      "enabled": true,
      "providers": ["your-provider"],
      "cachedContext": true
    },
    "imageGeneration": {
      "enabled": true,
      "defaultModel": "gpt-image-1.5",
      "allowedModels": ["gpt-image-1.5", "gpt-image-2"],
      "timeoutMs": 300000,
      "artifactDirectory": ".pi/generated-images"
    }
  }
}
```

| 配置项 | 含义 |
|---|---|
| `responsesWebSocket.enabled` | 是否给指定 provider 增加 WebSocket 传输。默认关闭。 |
| `responsesWebSocket.providers` | provider ID 列表，默认空。启用时必须填写，只选择使用 `openai-responses` 的 provider。 |
| `responsesWebSocket.cachedContext` | 是否准备增量缓存。默认开启；关闭后发送完整历史，不加载版本敏感的转换函数。 |
| `imageGeneration.enabled` | 是否注册 `imagegen`。默认关闭。 |
| `imageGeneration.defaultModel` | 独立 Images API 的默认模型，默认 `gpt-image-1.5`。 |
| `imageGeneration.allowedModels` | 允许调用的图片模型列表，必须包含默认模型。 |
| `imageGeneration.timeoutMs` | 每张图片请求的超时，单位为毫秒，默认 300000。允许 1000 至 3600000。 |
| `imageGeneration.artifactDirectory` | 默认输出目录，相对于工作目录，也可以填写绝对路径。 |

图片生成使用当前会话模型的 provider，不受 WebSocket 的 provider 列表限制。图片模型不会替换当前对话模型。配置不接受凭证或端点字段，也不支持上游的其他功能字段。

- `/toolkit-config`：显示配置路径和当前磁盘配置。
- `/toolkit-config validate`：校验配置，不发起模型请求。

修改配置后执行 `/reload` 或重启 Pi。磁盘校验成功不代表运行中的配置已经更新。

### 从旧本地插件迁移

旧的 schema-v2 配置可以继续使用，文件内容无需改变。先备份旧文件，再将它移到 agent 根目录。如果新文件已经存在，先比较两份配置，不要覆盖。

```bash
mv -n ~/.pi/agent/extensions/pi-openai-toolkit/config.json ~/.pi/agent/pi-openai-toolkit.json
```

省略 `cachedContext` 时默认开启。旧路径兼容只用于读取，不会自动搬动或重写文件。

切换到 Git 安装时，再把旧本地插件目录备份到 `extensions` 之外，避免重复加载。个人配置保留在 agent 根目录，无需创建配置专用的扩展目录。你的 provider ID 只放在个人配置中，不需要改源码。

## WebSocket

传输方式继续由 Pi 的 `transport` 设置控制：

| 设置 | 行为 |
|---|---|
| `auto` | 优先 WebSocket。握手网络失败，或服务返回 HTTP 400、404、405、426、501 时，可在请求发送前回退到 HTTP/SSE。 |
| `websocket` | 强制 WebSocket，每轮发送完整历史。 |
| `websocket-cached` | 强制 WebSocket。启用缓存且历史匹配时发送 `previous_response_id` 和增量输入，否则发送完整历史。 |
| `sse` | 使用 Pi 原生 HTTP/SSE。 |

`auto` 也支持连接复用和增量续传。`cachedContext: false` 会关闭 `auto` 和 `websocket-cached` 的增量缓存，但保留连接复用及 `auto` 的握手回退。

分支切换、压缩、工具声明或请求参数变化会使旧增量缓存失效。服务拒绝缓存的响应 ID 时，会在响应开始前用完整历史重试一次 WebSocket。

鉴权、额度和服务端错误不会触发 HTTP 回退。WebSocket 请求发送后的断线也不会触发回退，避免重复执行。Pi 自身的重试策略仍然有效。

## 图片生成和编辑

例如，向 Pi 发出指令：

```text
生成一张水彩风格的红狐狸图片，保存到 ./fox.png。
```

Pi 可以调用 `imagegen`：

| 参数 | 说明 |
|---|---|
| `prompt` | 必填，生成或编辑指令。 |
| `model` | 配置允许的图片模型 ID。省略时使用默认模型。 |
| `size` | `auto`、`1024x1024`、`1536x1024` 或 `1024x1536`。 |
| `quality` | `auto`、`low`、`medium` 或 `high`。 |
| `referenceImagePaths` | 最多 16 个本地 PNG、JPEG 或 WebP 路径。提供后调用 `/images/edits`。 |
| `batchSize` | 1 至 10，默认 1。每张图片发起一次独立请求。 |
| `outputPath` | 单张图片的目标 `.png` 路径。省略时保存到配置目录。 |

编辑示例：

```json
{
  "prompt": "把背景改成雪地，保留狐狸的造型",
  "referenceImagePaths": ["./fox.png"],
  "outputPath": "./fox-snow.png"
}
```

插件不会自动重试图片请求，也不会覆盖已有文件。目标文件在请求前以独占方式创建；批次中途失败或取消时，已保存的图片会保留，未使用的目标文件会清理。

普通调用返回图片预览和路径。codemode 调用返回结构化路径，展示图片时需要再读取文件：

```javascript
const result = await tools.imagegen({ prompt: "一只雪地里的红狐狸，水彩风格" });
for (const artifact of result.artifacts) {
  image(await tools.read({ path: artifact.path }));
}
if (result.error) text(result.error);
```

图片工具要求当前模型使用 `openai-responses`，且同一个 provider 的基础 URL 提供 `/images/generations` 和 `/images/edits`。目前不适配原生 Codex OAuth、Azure 图片路由或仅返回图片 URL 的服务。生成结果要求为 base64 编码的 PNG。

单张参考图最大为 32 MiB，参考图总大小最大为 50 MiB。单次响应最大为 48 MiB，输出 PNG 最大为 32 MiB。图片请求不跟随重定向，错误结果不包含服务端响应体或凭证。

## 开发和发布检查

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

`check` 包含 TypeScript 检查和离线测试。集成测试使用开发依赖中的 Pi、本地 WebSocket 服务及模拟图片响应，不读取个人凭证，不调用收费服务。GitHub Actions 配置了 Node.js 22 和 24；远端 CI 需要推送仓库后运行。

Pi 宿主包按官方建议声明为 `*` peer dependencies。这个声明用于宿主模块映射，不表示所有 Pi 版本都兼容。开发依赖固定 Pi 1.1.0，增量缓存也有运行时版本检查。

`.gitignore` 排除个人配置、凭证文件、环境文件、默认输出目录和依赖目录。不要把整个 `~/.pi/agent/`、`auth.json`、`models.json`、搜索配置或日志复制到公开仓库。插件文件与示例配置由 `package.json` 的 `files` 列表限定。

联网搜索仍由其他插件负责。例如，`pi-web-access` 的 `openaiUseAlphaSearch` 属于 `web-search.json`，不是本插件配置。

## 许可与参考

本项目使用 [MIT License](LICENSE)。项目来源及依赖关系见 [NOTICE.md](NOTICE.md)。

协议参考：[OpenAI WebSocket Mode](https://developers.openai.com/api/docs/guides/websocket-mode)、[Create image](https://developers.openai.com/api/reference/resources/images/methods/generate) 和 [Create image edit](https://developers.openai.com/api/reference/resources/images/methods/edit)。
