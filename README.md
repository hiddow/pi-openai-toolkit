# pi-openai-bridge

## 功能和兼容范围

这是一个独立维护的 Pi 插件，提供 V2 远程上下文压缩和 `imagegen`。项目由本地 `hiddow-websocket` 扩展而来，参考了 [awoaCrim/pi-openai-toolkit](https://github.com/awoaCrim/pi-openai-toolkit) 的协议和配置结构。它不包含上游的远程窗口、history/notes 或搜索功能，也不兼容完整的上游配置。

0.2.0 已移除 WebSocket 传输、增量连接缓存、自动降级和传输状态提示。对话传输由 Pi 或专用 provider 插件负责；本插件不再维护 WebSocket 连接。

- Node.js：22.19.0 或更新版本。
- Pi：已验证 1.1.0 的 Node.js 发行版，包括 CLI 和 SDK 扩展加载。
- Bun、嵌入式单文件发行版和其他 Pi 版本：未验证。

插件复用 Pi 的 provider、模型、端点、请求头和凭证。它不修改 `models.json`、`auth.json` 或模型列表，也不包含 `ws` 运行时依赖。

## 安装和更新

npm 包名为 `pi-openai-bridge`，不使用 scope。安装和更新：

```bash
pi install npm:pi-openai-bridge
pi update --extensions
```

需要固定版本时，可以使用 `npm:pi-openai-bridge@0.2.0`。未指定版本的安装随包更新；固定版本保持不变。

源码仍由 [hiddow/pi-openai-toolkit](https://github.com/hiddow/pi-openai-toolkit) 管理。也可以通过 Git 安装：

```bash
pi install git:github.com/hiddow/pi-openai-toolkit
```

Git 标签和提交同样可以固定版本。此前发布的 `v0.1.0` 标签保留原来的包名，不会重写。

本地开发也可以加载整个包：

```bash
npm ci --ignore-scripts
pi --no-extensions -e .
```

不要同时加载本项目的 npm、Git 和本地副本，也不要同时加载其他注册 `imagegen` 或 `/toolkit-config` 的插件。

## 外部配置

**无配置时，远程压缩和图片工具默认关闭。** 默认配置文件直接放在 agent 根目录：

```text
~/.pi/agent/pi-openai-toolkit.json
```

配置文件名、`PI_OPENAI_TOOLKIT_CONFIG`、`imagegen` 和 `/toolkit-config` 保持不变。升级到 0.2.0 前，需要删除旧配置中的 `defaults.responsesWebSocket` 整段。保留该字段会导致配置校验失败。

设置了 `PI_CODING_AGENT_DIR` 时，插件使用该 agent directory。npm 和 Git 安装位置都与配置位置分开，更新插件不会覆盖个人配置。

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
    "remoteCompaction": {
      "enabled": true,
      "models": ["your-provider/your-model"],
      "timeoutMs": 120000
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
| `imageGeneration.enabled` | 是否注册 `imagegen`。默认关闭。 |
| `imageGeneration.defaultModel` | 独立 Images API 的默认模型，默认 `gpt-image-1.5`。 |
| `imageGeneration.allowedModels` | 允许调用的图片模型列表，必须包含默认模型。 |
| `imageGeneration.timeoutMs` | 每张图片请求的超时，单位为毫秒，默认 300000。允许 1000 至 3600000。 |
| `imageGeneration.artifactDirectory` | 默认输出目录，相对于工作目录，也可以填写绝对路径。 |

图片生成使用当前会话模型的 provider。图片模型不会替换当前对话模型。远程压缩使用单独的精确模型名单，配置见下一节。配置不接受凭证或端点字段，也不支持完整的上游配置。

- `/toolkit-config`：显示配置路径和当前磁盘配置。
- `/toolkit-config validate`：校验配置，不发起模型请求。

修改配置后执行 `/reload` 或重启 Pi。磁盘校验成功不代表运行中的配置已经更新。

### 从旧本地插件迁移

旧的 schema-v2 图片和远程压缩配置可以继续使用；先删除 `defaults.responsesWebSocket` 整段。先备份旧文件，再将它移到 agent 根目录。如果新文件已经存在，先比较两份配置，不要覆盖。

```bash
mv -n ~/.pi/agent/extensions/pi-openai-toolkit/config.json ~/.pi/agent/pi-openai-toolkit.json
```

旧路径兼容只用于读取，不会自动搬动或重写文件。

切换到 npm 或 Git 安装时，再把旧本地插件目录备份到 `extensions` 之外，避免重复加载。个人配置保留在 agent 根目录，无需创建配置专用的扩展目录。你的 provider ID 只放在个人配置中，不需要改源码。

## 远程上下文压缩

在 `defaults` 中加入以下配置。把 `your-provider/your-model` 换成已验证的精确模型 ID：

```json
"remoteCompaction": {
  "enabled": true,
  "models": ["your-provider/your-model"],
  "timeoutMs": 120000
}
```

只支持使用 `openai-responses` 的模型。压缩沿用 Pi 的自动触发阈值、`/compact [instructions]` 和最近消息保留边界。插件把较早消息作为原生 Responses 项发送，不先转成文本，也不按 Pi 文本摘要的 2,000 字符上限截断工具输出。最近消息仍按 Pi 的设置原样保留。

插件在 HTTP/SSE（Server-Sent Events，服务端发送事件）请求末尾加入 `compaction_trigger`。只接受已完成、非空且证据一致的加密 checkpoint，并将它存入 Pi 的 compaction entry。后续 Responses 请求用 checkpoint 替换摘要占位消息。再次压缩时，输入包含旧 checkpoint 和新增的较早消息，已封存的消息不会重复发送。

输入来源是 Pi 的 compaction preparation 和持久化 session projection。它遵守持久化的 context edits，但不会重新执行其他扩展的请求时 context transforms。重放要求摘要锚点仍然存在；其他扩展删除或修改锚点时，请求会停止。远程压缩未验证其他 Pi 版本，也不保证无损保存所有细节。

| 配置项 | 含义 |
|---|---|
| `remoteCompaction.enabled` | 是否生成远程 checkpoint。默认关闭。 |
| `remoteCompaction.models` | 精确 `provider/model` 名单，默认空。启用时必须填写。 |
| `remoteCompaction.timeoutMs` | 单次请求超时，默认 120,000 毫秒。允许 1,000 至 3,600,000。 |

第一次远程压缩失败时，插件明确提示并交给 Pi 生成文本摘要。取消操作不会回退。会话已有远程 checkpoint 后，压缩失败会保留当前上下文并取消，不会把不透明占位符当成可读摘要。插件不会探测独立 `/responses/compact` 接口，也不更换压缩模型或账号。

checkpoint 绑定原 provider、模型和基础 URL。重放不受 `enabled` 控制，但需要保留 `models` 名单和插件。更换模型、账号或端点前，请先开启新会话。编辑已封存的历史会阻止重放和再次压缩；可以通过 `/tree` 返回 checkpoint 之前重建。树导航若要摘要一个包含 checkpoint 的分支，插件会拒绝；请选择不生成分支摘要。

2026-10-10 的合成文本实测确认：`hiddow` 当前可调用的 8 个 GPT 对话型号均可生成 V2 checkpoint，并通过后续请求恢复测试标记和约束。型号包括 `gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` 和 `gpt-5.5`。其中 `gpt-6.1-sol` 还通过了已安装插件的持久化、重开会话和递归压缩验证。

配置中的 `gpt-5.4`、`gpt-5.4-mini` 和 `gpt-5.3-codex-spark`，在压缩请求和普通对话请求中均返回 HTTP 400、`model_not_found`。这表明这些型号在当时的账号或路由上不可调用，无法据此判断压缩能力。图片模型 `gpt-image-*` 未参与对话压缩测试。

相同网关的 history/notes 只读入口返回 HTTP 404，因此本插件没有添加远程窗口工具。这些结果只覆盖已验证型号、端点和当时的凭证权限，不代表未来型号会自动获得支持。

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

维护者发布前需要登录 npm，并确认有权发布该名称。`npm publish` 会先执行检查：

```bash
npm login --registry=https://registry.npmjs.org
npm publish --access public
```

不要把 npm token、验证码或账户配置提交到仓库。

`check` 包含 TypeScript 检查和离线测试。集成测试使用开发依赖中的 Pi、本地 HTTP/SSE 服务及模拟响应。测试覆盖 checkpoint 持久化、重开会话、递归压缩、完整工具输出、封存历史编辑，以及请求钩子和自定义 fetch 的透传。不读取个人凭证，也不调用收费服务。GitHub Actions 配置了 Node.js 22 和 24；远端 CI 需要推送仓库后运行。

Pi 宿主包按官方建议声明为 `*` peer dependencies。这个声明用于宿主模块映射，不表示所有 Pi 版本都兼容。开发依赖固定 Pi 1.1.0。

`.gitignore` 排除个人配置、凭证文件、环境文件、默认输出目录和依赖目录。不要把整个 `~/.pi/agent/`、`auth.json`、`models.json`、搜索配置或日志复制到公开仓库。插件文件与示例配置由 `package.json` 的 `files` 列表限定。

联网搜索仍由其他插件负责。例如，`pi-web-access` 的 `openaiUseAlphaSearch` 属于 `web-search.json`，不是本插件配置。

## 许可与参考

本项目使用 [MIT License](LICENSE)。项目来源及依赖关系见 [NOTICE.md](NOTICE.md)。

协议参考：[Create image](https://developers.openai.com/api/reference/resources/images/methods/generate) 和 [Create image edit](https://developers.openai.com/api/reference/resources/images/methods/edit)。
