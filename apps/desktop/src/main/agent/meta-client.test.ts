import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
	MetaApiError,
	MetaClient,
	type MetaRequest,
	type MetaStreamEvent,
	type ModelTimingRecord,
	type UsageRecord,
} from "./meta-client";
import { assertStandardModel, estimateCostUsd, routeModel } from "./models";

const request: MetaRequest = {
	requestId: "request-1",
	workload: "quick",
	instructions: "Review code",
	input: [],
};
function responseEvent(output: Record<string, unknown>[] = [], model = "muse-spark-1.3") {
	return {
		type: "response.completed",
		response: {
			id: "response-1",
			model,
			status: "completed",
			output,
			usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 10 },
		},
	};
}
function sseResponse(events: unknown[], fragment = 7): Response {
	const bytes = new TextEncoder().encode(
		events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("")
	);
	let offset = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset >= bytes.length) return controller.close();
				controller.enqueue(bytes.slice(offset, offset + fragment));
				offset += fragment;
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } }
	);
}
async function collect(client: MetaClient, input = request, signal = new AbortController().signal) {
	const events = [];
	for await (const e of client.stream(input, signal)) events.push(e);
	return events;
}

test("optional timings separate credentials, headers, SSE text and terminal without recording content", async () => {
	let now = 0;
	const timings: ModelTimingRecord[] = [];
	const usage: UsageRecord[] = [];
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let sentBytes = 0;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } }
	);
	const emit = (event: unknown) =>
		controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
	const input: MetaRequest = {
		...request,
		requestId: "PRIVATE-REQUEST-ID",
		instructions: "PRIVATE-INSTRUCTIONS é",
		input: [{ role: "user", content: "PRIVATE-TRANSCRIPT" }],
		tools: [
			{
				type: "function",
				name: "private_tool",
				description: "PRIVATE-TOOL-DESCRIPTION",
				parameters: { type: "object", properties: {} },
			},
		],
		maxOutputTokens: 2048,
	};
	const client = new MetaClient({
		now: () => now,
		getApiKey: async () => {
			now = 12;
			return "PRIVATE-KEY";
		},
		recordUsage: (record) => usage.push(record),
		recordTiming: (record) => timings.push(record),
		fetch: async (_url, init) => {
			sentBytes = Buffer.byteLength(String(init?.body));
			now = 30;
			return response;
		},
	});
	const iterator = client.stream(input, new AbortController().signal);
	const first = iterator.next();
	await setImmediate();
	now = 50;
	emit({ type: "response.created", response: { id: "PRIVATE-RESPONSE-ID" } });
	await setImmediate();
	now = 80;
	emit({ type: "response.output_text.delta", delta: "PRIVATE-REPLY" });
	assert.equal((await first).value?.type, "text");
	assert.equal(timings.length, 0);
	const terminal = iterator.next();
	now = 200;
	emit(responseEvent());
	assert.equal((await terminal).value?.type, "completed");
	now = 210;
	await iterator.next();
	assert.equal(timings.length, 1);
	assert.equal(usage.length, 1);
	const hash = (value: string) => createHash("sha256").update(value).digest("hex");
	assert.deepEqual(timings[0], {
		requestHash: hash(input.requestId),
		attemptHash: hash(usage[0]?.attemptId ?? ""),
		workload: "quick",
		status: "completed",
		inputBytes: Buffer.byteLength(JSON.stringify(input.input)),
		instructionBytes: Buffer.byteLength(input.instructions),
		toolBytes: Buffer.byteLength(JSON.stringify(input.tools)),
		inputItems: 1,
		toolCount: 1,
		maxOutputTokens: 2048,
		requestBytes: sentBytes,
		credentialMs: 12,
		headersMs: 18,
		firstEventMs: 38,
		firstTextMs: 68,
		terminalMs: 188,
		durationMs: 210,
		streamedTextChars: 13,
		functionCalls: 0,
		httpStatus: 200,
		inputTokens: 100,
		cachedInputTokens: 20,
		outputTokens: 10,
	});
	assert(!JSON.stringify(timings).includes("PRIVATE"));
	assert(!JSON.stringify(timings).includes("private_tool"));
});

test("timings retain unknown stages and separate HTTP, incomplete and non-streamed tool attempts", async () => {
	const cases = [
		{ response: () => new Response("PRIVATE-ERROR", { status: 429 }), status: "failed" },
		{
			response: () =>
				sseResponse([
					{
						...responseEvent(),
						type: "response.incomplete",
						response: {
							...responseEvent().response,
							status: "incomplete",
							incomplete_details: { reason: "max_output_tokens" },
						},
					},
				]),
			status: "incomplete",
		},
		{
			response: () =>
				sseResponse([
					responseEvent([
						{ type: "function_call", name: "private_tool", arguments: "PRIVATE-ARGUMENTS" },
					]),
				]),
			status: "completed",
		},
	];
	for (const item of cases) {
		const timings: ModelTimingRecord[] = [];
		const client = new MetaClient({
			getApiKey: async () => "key",
			recordUsage: () => {},
			recordTiming: (record) => timings.push(record),
			fetch: async () => item.response(),
		});
		if (item.status === "completed") await collect(client);
		else await assert.rejects(collect(client), MetaApiError);
		assert.equal(timings.length, 1);
		assert.equal(timings[0]?.status, item.status);
		assert.equal(timings[0]?.firstTextMs, null);
		assert.equal(timings[0]?.streamedTextChars, 0);
		assert.equal(
			timings[0]?.functionCalls,
			item.status === "completed" ? 1 : item.status === "failed" ? null : 0
		);
		assert.equal(timings[0]?.httpStatus, item.status === "failed" ? 429 : 200);
		assert(!JSON.stringify(timings).includes("PRIVATE"));
		assert(!JSON.stringify(timings).includes("private_tool"));
	}
});

test("timings record a cancelled pending read once and survive a failing observer", async () => {
	const timings: ModelTimingRecord[] = [];
	const usage: UsageRecord[] = [];
	const caller = new AbortController();
	let cancelled = 0;
	const client = new MetaClient({
		getApiKey: async () => "key",
		recordUsage: (record) => usage.push(record),
		recordTiming: (record) => {
			timings.push(record);
			throw new Error("Diagnostic sink failed");
		},
		fetch: async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled++;
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			),
	});
	const result = collect(client, request, caller.signal);
	await setImmediate();
	caller.abort();
	await assert.rejects(result, { name: "AbortError" });
	assert.equal(cancelled, 1);
	assert.equal(timings.length, 1);
	assert.equal(timings[0]?.status, "cancelled");
	assert.equal(timings[0]?.firstEventMs, null);
	assert.equal(timings[0]?.terminalMs, null);
	assert.equal(usage.length, 1);
	assert.equal(usage[0]?.status, "cancelled");

	const complete = new MetaClient({
		getApiKey: async () => "key",
		recordUsage: () => {},
		recordTiming: () => {
			throw new Error("Diagnostic sink failed");
		},
		fetch: async () => sseResponse([responseEvent()]),
	});
	assert.equal((await collect(complete)).at(-1)?.type, "completed");
});

test("timings expose missing credentials and consumer interruption without inventing terminal samples", async () => {
	const timings: ModelTimingRecord[] = [];
	const missing = new MetaClient({
		getApiKey: async () => null,
		recordUsage: () => {
			throw new Error("No provider request expected");
		},
		recordTiming: (record) => timings.push(record),
		fetch: async () => {
			throw new Error("No provider request expected");
		},
	});
	await assert.rejects(collect(missing), /credential unavailable/);
	assert.equal(timings[0]?.status, "failed");
	assert.equal(timings[0]?.requestBytes, null);
	assert.equal(timings[0]?.headersMs, null);
	assert.equal(timings[0]?.firstTextMs, null);
	assert.equal(timings[0]?.terminalMs, null);
	const client = new MetaClient({
		getApiKey: async () => "key",
		recordUsage: () => {},
		recordTiming: (record) => timings.push(record),
		fetch: async () => sseResponse([{ type: "response.output_text.delta", delta: "Hello" }]),
	});
	const iterator = client.stream(request, new AbortController().signal);
	assert.equal((await iterator.next()).value?.type, "text");
	await iterator.return(undefined);
	assert.equal(timings.length, 2);
	assert.equal(timings[1]?.status, "interrupted");
	assert.equal(timings[1]?.terminalMs, null);
	assert.equal(timings[1]?.streamedTextChars, 5);
});

test("routes only allowlisted standard models and prices cached input separately", () => {
	assert.equal(routeModel("quick"), "muse-spark-1.3");
	assert.equal(routeModel("deep"), "muse-wonder-1.0");
	assert.throws(() => assertStandardModel("muse-spark-1.3-contributor"));
	assert.throws(() => assertStandardModel("muse-wonder-full"));
	assert.equal(
		estimateCostUsd("muse-spark-1.3", {
			inputTokens: 100,
			cachedInputTokens: 20,
			outputTokens: 10,
		}),
		0.0001455
	);
	assert.throws(() =>
		estimateCostUsd("muse-spark-1.3", { inputTokens: 1, cachedInputTokens: 2, outputTokens: 0 })
	);
});

test("stream handles split UTF-8 and CRLF, preserves encrypted output, logs usage without content", async () => {
	const logs: UsageRecord[] = [];
	const reasoning = { type: "reasoning", encrypted_content: "opaque", summary: [] };
	const client = new MetaClient({
		getApiKey: async () => "secret-test-key",
		recordUsage: (r) => logs.push(r),
		fetch: async (url, init) => {
			assert.equal(url, "https://api.meta.ai/v1/responses");
			const body = JSON.parse(String(init?.body));
			assert.equal(body.model, "muse-spark-1.3");
			assert.equal(body.store, false);
			assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
			assert.equal(body.parallel_tool_calls, false);
			return sseResponse(
				[{ type: "response.output_text.delta", delta: "café 🎙" }, responseEvent([reasoning])],
				1
			);
		},
	});
	const events = await collect(client);
	assert.deepEqual(events[0], { type: "text", delta: "café 🎙" });
	assert.deepEqual(events[1], {
		type: "completed",
		response: { id: "response-1", model: "muse-spark-1.3", output: [reasoning] },
	});
	assert.equal(logs.length, 1);
	assert.equal(logs[0]?.estimatedUsd, 0.0001455);
	assert.equal(logs[0]?.status, "completed");
	assert(!JSON.stringify(logs).includes("secret-test-key"));
	assert(!JSON.stringify(logs).includes("opaque"));
});

test("missing credential never sends a request; HTTP errors retain status but suppress server payload", async () => {
	let calls = 0;
	const missing = new MetaClient({
		getApiKey: async () => null,
		recordUsage: () => {},
		fetch: async () => {
			calls++;
			return new Response();
		},
	});
	await assert.rejects(collect(missing), /credential unavailable/);
	assert.equal(calls, 0);
	const rejected = new MetaClient({
		getApiKey: async () => "key",
		recordUsage: () => {},
		fetch: async () =>
			new Response("sensitive server message", { status: 429, headers: { "Retry-After": "2" } }),
	});
	await assert.rejects(
		collect(rejected),
		(e: unknown) =>
			e instanceof MetaApiError &&
			e.status === 429 &&
			e.retryAfter === "2" &&
			!e.message.includes("sensitive")
	);
});

test("truncated, incomplete, and contributor streams never complete or make up zero cost", async () => {
	for (const events of [
		[{ type: "response.output_text.delta", delta: "partial" }],
		[
			{
				type: "response.incomplete",
				response: { ...responseEvent().response, status: "incomplete" },
			},
		],
		[responseEvent([], "muse-spark-1.3-contributor")],
	]) {
		const logs: UsageRecord[] = [];
		const client = new MetaClient({
			getApiKey: async () => "key",
			recordUsage: (r) => logs.push(r),
			fetch: async () => sseResponse(events),
		});
		await assert.rejects(collect(client));
		assert.notEqual(logs[0]?.status, "completed");
		if (events[0]?.type === "response.output_text.delta") assert.equal(logs[0]?.estimatedUsd, null);
	}
});

test("cancellation stops a stalled stream and records unknown usage", async () => {
	const logs: UsageRecord[] = [];
	let cancelled = false;
	const controller = new AbortController();
	const client = new MetaClient({
		getApiKey: async () => "key",
		recordUsage: (r) => logs.push(r),
		fetch: async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			),
	});
	const result = collect(client, request, controller.signal);
	setTimeout(() => controller.abort(), 5);
	await assert.rejects(result, { name: "AbortError" });
	assert(cancelled);
	assert.equal(logs[0]?.status, "cancelled");
	assert.equal(logs[0]?.estimatedUsd, null);
});

test("a fetch completing after cancellation is discarded and its body is cancelled without waiting", async () => {
	const logs: UsageRecord[] = [];
	const controller = new AbortController();
	let deliver: (response: Response) => void = () => {};
	const response = new Promise<Response>((resolve) => {
		deliver = resolve;
	});
	let requested = false;
	let bodyCancelled = false;
	const client = new MetaClient({
		getApiKey: async () => "key",
		recordUsage: (record) => logs.push(record),
		fetch: () => {
			requested = true;
			return response;
		},
	});
	const pending = collect(client, request, controller.signal);
	await setImmediate();
	assert(requested);
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(logs.length, 1);
	assert.equal(logs[0]?.status, "cancelled");
	assert.equal(logs[0]?.usage, null);
	assert.equal(logs[0]?.estimatedUsd, null);
	deliver(
		new Response(
			new ReadableStream({
				start(stream) {
					stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(responseEvent())}\n\n`));
				},
				cancel() {
					bodyCancelled = true;
					return new Promise<void>(() => {});
				},
			}),
			{ headers: { "Content-Type": "text/event-stream" } }
		)
	);
	await setImmediate();
	assert(bodyCancelled);
	assert.equal(logs.length, 1);
});

test("cancellation does not wait forever for a stream adapter's cleanup promise", async () => {
	const controller = new AbortController();
	const client = new MetaClient({
		getApiKey: async () => "key",
		recordUsage: () => {},
		fetch: async () =>
			new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), {
				headers: { "Content-Type": "text/event-stream" },
			}),
	});
	const result = collect(client, request, controller.signal);
	setTimeout(() => controller.abort(), 5);
	await assert.rejects(result, { name: "AbortError" });
});

test("HTTP body cleanup is bounded by timeout and still records the attempt", async () => {
	const logs: UsageRecord[] = [];
	const client = new MetaClient({
		getApiKey: async () => "key",
		recordUsage: (record) => logs.push(record),
		timeoutMs: 10,
		fetch: async () =>
			new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), {
				status: 429,
			}),
	});
	await assert.rejects(collect(client), /HTTP 429/);
	assert.equal(logs.length, 1);
	assert.equal(logs[0]?.estimatedUsd, null);
});

test("invalid usage and contradictory terminal status are rejected without losing accounting", async () => {
	for (const kind of ["usage", "status"] as const) {
		const terminal = responseEvent();
		if (kind === "usage") terminal.response.usage.input_tokens_details.cached_tokens = 101;
		else terminal.response.status = "incomplete";
		const logs: UsageRecord[] = [];
		const client = new MetaClient({
			getApiKey: async () => "key",
			recordUsage: (record) => logs.push(record),
			fetch: async () => sseResponse([terminal]),
		});
		await assert.rejects(collect(client));
		assert.equal(logs.length, 1);
		assert.equal(logs[0]?.status, "failed");
		if (kind === "usage") {
			assert.equal(logs[0]?.usage, null);
			assert.equal(logs[0]?.estimatedUsd, null);
		}
	}
});

test("512-token incomplete terminals retain actual usage and expose only safe recovery codes, never tools", async () => {
	for (const [reason, outputTokens, terminalType, code] of [
		[undefined, 512, "response.incomplete", "output-limit"],
		["max_output_tokens", 512, "response.incomplete", "output-limit"],
		[undefined, 100, "response.incomplete", "incomplete"],
		["content_filter", 512, "response.incomplete", "incomplete"],
		["max_output_tokens", 512, "response.completed", null],
	] as const) {
		const logs: UsageRecord[] = [];
		const events: MetaStreamEvent[] = [];
		const client = new MetaClient({
			getApiKey: async () => "test-only-key",
			recordUsage: (record) => logs.push(record),
			fetch: async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				assert.equal(body.max_output_tokens, 512);
				assert.equal(body.tool_choice, "auto");
				return sseResponse([
					{ type: "response.output_text.delta", delta: "Unfinished answer" },
					{
						type: terminalType,
						response: {
							id: "actual-usage-repro",
							model: "muse-spark-1.3",
							status: "incomplete",
							output: [{ type: "function_call", arguments: "SECRET partial tool" }],
							usage: { input_tokens: 4410, output_tokens: outputTokens },
							...(reason ? { incomplete_details: { reason } } : {}),
						},
					},
				]);
			},
		});
		await assert.rejects(
			async () => {
				for await (const event of client.stream(
					{ ...request, maxOutputTokens: 512 },
					new AbortController().signal
				))
					events.push(event);
			},
			(error: unknown) =>
				error instanceof MetaApiError && error.code === code && !error.message.includes("SECRET")
		);
		assert.deepEqual(events, [{ type: "text", delta: "Unfinished answer" }]);
		assert.equal(logs.length, 1);
		assert.equal(logs[0]?.status, terminalType === "response.incomplete" ? "incomplete" : "failed");
		assert.deepEqual(logs[0]?.usage, { inputTokens: 4410, cachedInputTokens: 0, outputTokens });
		assert(logs[0]?.estimatedUsd);
		assert(!JSON.stringify(logs).includes("SECRET"));
	}
});

test("truncated stream has a distinct recovery code and tool-free requests use Meta-compatible empty tools", async () => {
	const client = new MetaClient({
		getApiKey: async () => "test-key",
		recordUsage: () => {},
		fetch: async (_url, init) => {
			assert.equal(JSON.parse(String(init?.body)).tool_choice, "auto");
			assert.deepEqual(JSON.parse(String(init?.body)).tools, []);
			return sseResponse([{ type: "response.output_text.delta", delta: "Partial" }]);
		},
	});
	await assert.rejects(
		collect(client),
		(error: unknown) => error instanceof MetaApiError && error.code === "stream-interrupted"
	);
});
