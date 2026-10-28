import { randomUUID } from "node:crypto";
import { z } from "zod";
import { abortable, throwIfAborted } from "./cancellation";
import {
	MODEL_API_URL,
	PRICING_VERIFIED_AT,
	type StandardModel,
	type TokenUsage,
	type Workload,
	assertStandardModel,
	estimateCostUsd,
	routeModel,
} from "./models";

const object = z.record(z.string(), z.unknown());
const usageSchema = z.object({
	input_tokens: z.number().int().nonnegative(),
	output_tokens: z.number().int().nonnegative(),
	input_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }).optional(),
});
const responseSchema = z.object({
	id: z.string().min(1),
	model: z.string(),
	status: z.string(),
	output: z.array(object),
	usage: usageSchema.nullish(),
	incomplete_details: z.object({ reason: z.string() }).nullish(),
});
export type MetaItem = z.infer<typeof object>;
export interface FunctionTool {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	strict?: boolean;
}
export interface MetaRequest {
	requestId: string;
	workload: Workload;
	input: MetaItem[];
	instructions: string;
	tools?: FunctionTool[];
	maxOutputTokens?: number;
}
export interface MetaCompletion {
	id: string;
	model: StandardModel;
	output: MetaItem[];
}
export type MetaStreamEvent =
	| { type: "text"; delta: string }
	| { type: "completed"; response: MetaCompletion };
/** Injectable provider boundary; scripted implementations belong in explicit test harnesses. */
export interface AgentModelClient {
	stream(request: MetaRequest, signal: AbortSignal): AsyncIterable<MetaStreamEvent>;
}
export interface UsageRecord {
	attemptId: string;
	requestId: string;
	responseId: string | null;
	model: StandardModel;
	status: "completed" | "failed" | "incomplete" | "cancelled" | "interrupted";
	usage: TokenUsage | null;
	/** Estimate from reported tokens and dated list prices; null means unknown, never zero. */
	estimatedUsd: number | null;
	pricingVerifiedAt: string;
}
export class MetaApiError extends Error {
	constructor(
		message: string,
		readonly status: number | null = null,
		readonly retryAfter: string | null = null,
		readonly code: "output-limit" | "incomplete" | "stream-interrupted" | null = null
	) {
		super(message);
		this.name = "MetaApiError";
	}
}

/** Native fetch avoids an SDK/manifest change. No raw prompts, secrets or responses in logs. */
export class MetaClient implements AgentModelClient {
	constructor(
		private readonly options: {
			getApiKey: () => Promise<string | null>;
			recordUsage: (record: UsageRecord) => void;
			fetch?: typeof fetch;
			timeoutMs?: number;
		}
	) {}

	async *stream(request: MetaRequest, callerSignal: AbortSignal): AsyncGenerator<MetaStreamEvent> {
		const model = routeModel(request.workload);
		const attemptId = randomUUID();
		assertStandardModel(model);
		const signal = AbortSignal.any([
			callerSignal,
			AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
		]);
		let status: UsageRecord["status"] = "interrupted";
		let usage: TokenUsage | null = null;
		let estimatedUsd: number | null = null;
		let responseId: string | null = null;
		let requested = false;
		try {
			throwIfAborted(signal);
			const key = await abortable(this.options.getApiKey(), signal);
			if (!key?.trim())
				throw new MetaApiError("Meta credential unavailable: configure MODEL_API_KEY");
			const maxOutputTokens = request.maxOutputTokens ?? 4096;
			if (
				!Number.isSafeInteger(maxOutputTokens) ||
				maxOutputTokens < 16 ||
				maxOutputTokens > 32768
			) {
				throw new MetaApiError("maxOutputTokens must be between 16 and 32768");
			}
			requested = true;
			const pendingResponse = (this.options.fetch ?? fetch)(MODEL_API_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify({
					model,
					input: request.input,
					instructions: request.instructions,
					tools: request.tools ?? [],
					parallel_tool_calls: false,
					tool_choice: request.tools?.length ? "auto" : "none",
					stream: true,
					store: false,
					include: ["reasoning.encrypted_content"],
					reasoning: { effort: request.workload === "quick" ? "minimal" : "high" },
					max_output_tokens: maxOutputTokens,
				}),
				signal,
			});
			const response = await abortable(pendingResponse, signal).catch((error: unknown) => {
				// An adapter may ignore abort and resolve later. Reclaim its unowned body
				// without delaying cancellation or recording the attempt a second time.
				void pendingResponse.then((late) => cancelBody(late.body, signal)).catch(() => {});
				throw error;
			});
			if (!response.ok) {
				status = "failed";
				await cancelBody(response.body, signal);
				throw new MetaApiError(
					`Meta request rejected (HTTP ${response.status}); check credentials, model access and quota`,
					response.status,
					response.headers.get("retry-after")
				);
			}
			if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
				status = "failed";
				await cancelBody(response.body, signal);
				throw new MetaApiError("Meta returned a non-streaming response");
			}
			for await (const payload of readSse(response.body, signal)) {
				throwIfAborted(signal);
				if (payload === "[DONE]") break;
				let event: Record<string, unknown>;
				try {
					event = object.parse(JSON.parse(payload));
				} catch {
					throw new MetaApiError("Malformed Meta streaming event");
				}
				if (event["type"] === "response.created") {
					const created = object.parse(event["response"]);
					if (typeof created["id"] === "string") responseId = created["id"];
					if (typeof created["model"] === "string") {
						assertStandardModel(created["model"]);
						if (created["model"] !== model)
							throw new MetaApiError("Meta returned an unexpected model");
					}
				}
				if (event["type"] === "response.output_text.delta") {
					if (typeof event["delta"] !== "string") throw new MetaApiError("Invalid text delta");
					yield { type: "text", delta: event["delta"] };
				}
				if (
					["response.completed", "response.failed", "response.incomplete"].includes(
						String(event["type"])
					)
				) {
					status = "failed";
					const parsed = responseSchema.safeParse(event["response"]);
					if (!parsed.success) throw new MetaApiError("Invalid Meta terminal response");
					const final = parsed.data;
					assertStandardModel(final.model);
					if (final.model !== model) throw new MetaApiError("Meta returned an unexpected model");
					responseId = final.id;
					if (final.usage) {
						const reportedUsage = {
							inputTokens: final.usage.input_tokens,
							cachedInputTokens: final.usage.input_tokens_details?.cached_tokens ?? 0,
							outputTokens: final.usage.output_tokens,
						};
						// Commit accounting only after validation so finally can always log an unknown
						// cost when the provider supplies invalid token counts.
						try {
							estimatedUsd = estimateCostUsd(model, reportedUsage);
						} catch {
							throw new MetaApiError("Invalid Meta token usage");
						}
						usage = reportedUsage;
					}
					status =
						event["type"] === "response.completed"
							? "completed"
							: event["type"] === "response.failed"
								? "failed"
								: "incomplete";
					if (status !== "completed" || final.status !== "completed") {
						if (status === "completed") status = "failed";
						// Retry only a consistent output-limit terminal. Older provider responses may
						// omit the reason; their validated usage must have exhausted this request's cap.
						const incomplete = status === "incomplete" && final.status === "incomplete";
						const outputLimit =
							incomplete &&
							(final.incomplete_details?.reason === "max_output_tokens" ||
								(!final.incomplete_details && (usage?.outputTokens ?? 0) >= maxOutputTokens));
						throw new MetaApiError(
							`Meta response ${status}; partial output cannot execute tools`,
							null,
							null,
							outputLimit ? "output-limit" : incomplete ? "incomplete" : null
						);
					}
					yield { type: "completed", response: { id: final.id, model, output: final.output } };
					return;
				}
				if (event["type"] === "error") throw new MetaApiError("Meta streaming error");
			}
			throw new MetaApiError(
				"Meta stream ended without a completed response",
				null,
				null,
				"stream-interrupted"
			);
		} finally {
			if (signal.aborted) status = "cancelled";
			if (requested) {
				this.options.recordUsage({
					attemptId,
					requestId: request.requestId,
					responseId,
					model,
					status,
					usage,
					estimatedUsd,
					pricingVerifiedAt: PRICING_VERIFIED_AT,
				});
			}
		}
	}
}

async function cancelBody(body: ReadableStream<Uint8Array> | null, signal: AbortSignal) {
	if (body) await abortable(body.cancel(), signal).catch(() => {});
}

/** SSE framing is independent of TCP/UTF-8 chunk boundaries, supports CRLF and multi-line data. */
async function* readSse(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal
): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "";
	let data: string[] = [];
	let eventSize = 0;
	try {
		while (true) {
			const chunk = await abortable(reader.read(), signal);
			buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line === "") {
					if (data.length) yield data.join("\n");
					data = [];
					eventSize = 0;
				} else if (line.startsWith("data:")) {
					data.push(line.slice(5).replace(/^ /, ""));
					eventSize += line.length;
				}
				if (eventSize > 2_000_000) throw new MetaApiError("Meta event exceeds size limit");
				newline = buffer.indexOf("\n");
			}
			if (buffer.length > 2_000_000) throw new MetaApiError("Meta event exceeds size limit");
			if (chunk.done) return; // Unframed/truncated terminal events are never accepted.
		}
	} finally {
		await abortable(reader.cancel(), signal).catch(() => {});
		reader.releaseLock();
	}
}
