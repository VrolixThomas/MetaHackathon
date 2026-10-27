import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { MetaApiError, MetaClient, type MetaRequest, type UsageRecord } from "./meta-client";
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
