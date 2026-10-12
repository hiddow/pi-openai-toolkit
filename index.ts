import { Type } from "@earendil-works/pi-ai";
import { openAIResponsesApi, getCurrentTools, calculateCost } from "@earendil-works/pi-ai/compat";
import { convertToLlm, defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfigFile, resolveConfigPath } from "./config.cjs";
import { generateImages } from "./image-generation.cjs";
import { createCompactionController, checkpointDetails } from "./remote-compaction.cjs";

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

	const compaction = createCompactionController(config.remoteCompaction, {
		convertToLlm, getCurrentTools, api: openAIResponsesApi,
		toUsage(raw: any, model: any) {
			if (!raw) return undefined;
			const cacheRead = raw.input_tokens_details?.cached_tokens ?? 0;
			const cacheWrite = raw.input_tokens_details?.cache_write_tokens ?? 0;
			const usage = { input: Math.max(0, (raw.input_tokens ?? 0) - cacheRead - cacheWrite), output: raw.output_tokens ?? 0,
				cacheRead, cacheWrite, totalTokens: raw.total_tokens ?? (raw.input_tokens ?? 0) + (raw.output_tokens ?? 0),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			calculateCost(model, usage);
			return usage;
		},
	});
	pi.on("context_with_system", (event, ctx) => { compaction.captureHead(event.messages, ctx); });
	pi.on("session_before_compact", (event, ctx) => compaction.compact(event, ctx));
	pi.on("session_before_tree", (event, ctx) => {
		if (!event.preparation.userWantsSummary) return;
		try {
			if (!event.preparation.entriesToSummarize.some(entry => entry.type === "compaction" && checkpointDetails(entry))) return;
		} catch { /* Invalid checkpoint metadata must not become a text summary. */ }
		ctx.ui.notify("A remote checkpoint cannot be used as a text branch summary. Navigate without summarizing, or start a new session.", "error");
		return { cancel: true };
	});
	pi.on("before_provider_request", async (event, ctx) => {
		try { return await compaction.rewritePayload(event.payload, ctx); }
		catch {
			ctx.ui.notify("Remote checkpoint replay is unsafe. Use its original configured model, or navigate before the checkpoint.", "error");
			ctx.abort();
			// Extension handler errors are swallowed by Pi. Abort explicitly and
			// withhold the sentinel; the provider wrapper also validates replay.
			return { ...(event.payload as object), input: [], messages: [] };
		}
	});
	pi.on("cache_warming_decision", (_event, ctx) => {
		const entry = ctx.sessionManager.getBranch().slice().reverse().find(item => item.type === "compaction");
		try { if (checkpointDetails(entry)) return { action: "stop" as const }; }
		catch { return { action: "stop" as const }; }
	});
	pi.on("session_start", () => { compaction.reset(); });
	pi.on("session_tree", () => { compaction.reset(); });
	// Keep the replay guard for configured checkpoint providers without taking
	// ownership of their transport or changing unrelated provider registrations.
	const providers = new Set<string>(config.remoteCompaction.models.map((key: string) => key.slice(0, key.indexOf("/"))));
	for (const provider of providers) pi.registerProvider(provider, {
		api: "openai-responses",
		streamSimple(model, context, options) {
			return openAIResponsesApi().streamSimple(model, context, {
				...options,
				onPayload: async (payload, selectedModel) => {
					const transformed = await options?.onPayload?.(payload, selectedModel) ?? payload;
					options?.signal?.throwIfAborted();
					compaction.assertReplayPayload(transformed, context.messages);
					return transformed;
				},
			});
		},
	});
	pi.on("session_shutdown", () => { compaction.reset(); });
}
