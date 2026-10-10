import WebSocket from "ws";
import { Type } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { defineTool, getAgentDir, getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfigFile, resolveConfigPath } from "./config.cjs";
import { loadReplayHelpers } from "./pi-runtime.cjs";
import { generateImages } from "./image-generation.cjs";
import { createWebSocketTransport } from "./transport.cjs";

const artifactSchema = Type.Object({ path: Type.String(), mimeType: Type.String(), bytes: Type.Number() });
const resultSchema = Type.Object({
	provider: Type.String(), model: Type.String(), action: Type.String(),
	artifacts: Type.Array(artifactSchema), error: Type.Optional(Type.String()),
});

/** Preserve Pi's model metadata, endpoint and credential resolution. */
export default async function (pi: ExtensionAPI) {
	const agentDirectory = getAgentDir();
	const configPath = resolveConfigPath(agentDirectory);
	const requiredConfig = process.env.PI_OPENAI_TOOLKIT_CONFIG !== undefined;
	const config = loadConfigFile(configPath, requiredConfig);

	pi.registerCommand("toolkit-config", {
		description: "Show or validate Toolkit configuration (reload after edits)",
		handler: async (args, ctx) => {
			try {
				const currentPath = resolveConfigPath(agentDirectory);
				const current = loadConfigFile(currentPath, requiredConfig);
				if (args.trim() && args.trim() !== "validate") throw new Error("Usage: /toolkit-config [validate]");
				ctx.ui.notify(args.trim() === "validate" ? "Toolkit configuration is valid. Reload to apply changes." : `${currentPath}\n${JSON.stringify(current, null, 2)}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Invalid Toolkit configuration.", "error");
			}
		},
	});

	if (config.imageGeneration.enabled) pi.registerTool(defineTool({
		name: "imagegen",
		label: "Image generation",
		description: "Generate PNG images or edit local reference images using the current provider's Images API. Saves results without overwriting files. Each batch image is a separate paid request; failures are not retried. Returns artifact paths and image previews.",
		promptSnippet: "Generate or edit images and save PNG artifacts",
		promptGuidelines: [
			"Use imagegen when the user asks to create or edit images. Only upload reference images supplied or authorized by the user.",
			"Keep the user's requested prompt and report generated artifact paths. Do not switch the conversation model to an image model.",
			"From codemode, imagegen returns structured artifact paths; use read and image() to attach the saved images when needed.",
		],
		namespace: { name: "pi-openai-toolkit", description: "OpenAI-compatible image generation and editing" },
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1, maxLength: 32000, description: "Image generation or editing instructions" }),
			model: Type.Optional(Type.String({ description: `Image model ID; default ${config.imageGeneration.defaultModel}. Allowed: ${config.imageGeneration.allowedModels.join(", ")}` })),
			size: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("1024x1024"), Type.Literal("1536x1024"), Type.Literal("1024x1536")])),
			quality: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
			referenceImagePaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16, description: "Local PNG/JPEG/WebP paths; uploads these to the configured provider for editing" })),
			batchSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Number of separate requests; default 1" })),
			outputPath: Type.Optional(Type.String({ description: "Optional new .png file path for a single image, relative to cwd or absolute" })),
		}),
		outputSchema: resultSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = ctx.model;
			if (!model || model.api !== "openai-responses") throw new Error("imagegen requires an openai-responses model and an Images API on the same provider.");
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error("Cannot resolve image provider authentication. Check Pi's model and credentials.");
			const result = await generateImages({
				runtime: { api: model.api, baseUrl: auth.baseUrl ?? model.baseUrl, apiKey: auth.apiKey, headers: auth.headers, modelHeaders: model.headers },
				params, config: config.imageGeneration, cwd: ctx.cwd, signal,
				onImage: (artifacts: Array<{ path: string }>) => onUpdate?.({
					content: [{ type: "text", text: `Saved ${artifacts.length} image(s):\n${artifacts.map(item => item.path).join("\n")}` }], details: { artifacts },
				}),
			});
			const { images, ...details } = result;
			const structuredContent = { provider: model.provider, ...details };
			return {
				content: [{ type: "text" as const, text: `${result.error ? `${result.error}\n` : ""}Saved ${result.artifacts.length} image(s):\n${result.artifacts.map((item: { path: string }) => item.path).join("\n")}` }, ...images.map(image => ({ ...image, type: "image" as const }))],
				details: structuredContent, structuredContent, ...(result.error ? { isError: true } : {}),
			};
		},
	}));

	if (!config.responsesWebSocket.enabled) return;
	// Pi exposes the host package directory in both bundled CLI and SDK loads.
	const replay = config.responsesWebSocket.cachedContext
		? await loadReplayHelpers(getPackageDir())
		: undefined;
	const transport = createWebSocketTransport(WebSocket);

	for (const provider of config.responsesWebSocket.providers) pi.registerProvider(provider, {
		api: "openai-responses",
		streamSimple(model, context, options) {
			const api = openAIResponsesApi();
			if (model.api !== "openai-responses" || options?.transport === "sse") return api.streamSimple(model, context, options);
			const cacheOwner = Symbol();
			const stream = api.streamSimple(model, context, {
				...options,
				fetch: transport.fetchFor({ ...options, cacheOwner, cachedContext: config.responsesWebSocket.cachedContext, transport: options?.transport ?? "auto" }),
			});
			// Cache Pi's exact next-turn replay, including normalized tool IDs/arguments.
			void stream.result().then((message) => {
				if (!replay || !message.responseId || !["stop", "toolUse"].includes(message.stopReason)) return;
				const supportsGrammarTools = model.compat && "supportsOpenAIGrammarTools" in model.compat
					? model.compat.supportsOpenAIGrammarTools ?? false : false;
				const grammarToolInputProperties = replay.createGrammarToolInputProperties(replay.getDeclaredTools(context.messages), supportsGrammarTools);
				const replayItems = replay.convertResponsesMessages(
					model, { messages: [message] }, new Set(["openai", "openai-codex", "opencode"]),
					{ includeSystemPrompt: false, grammarToolInputProperties },
				).filter((item: { type: string }) => !["function_call_output", "custom_tool_call_output"].includes(item.type));
				transport.rememberResponse(message.responseId, replayItems, cacheOwner);
			}).catch(() => { /* Optional cache preparation: use full history next turn. */ });
			return stream;
		},
	});
	pi.on("session_shutdown", () => transport.close());
}
