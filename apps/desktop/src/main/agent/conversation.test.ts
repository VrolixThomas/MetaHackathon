import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ConversationPRContext,
	ConversationTurnInput,
	PollTurnResult,
} from "../../shared/contracts";
import { ConversationService } from "./conversation";
import { createConversationRouter } from "./conversation-router";
import {
	type AgentModelClient,
	MetaApiError,
	MetaClient,
	type MetaItem,
	type MetaRequest,
	type MetaStreamEvent,
} from "./meta-client";
import { eventually } from "./test-support";

// Explicit test provider output. No scripted provider is constructed by production service.
function end(output: MetaItem[] = []): MetaStreamEvent {
	return { type: "completed", response: { id: "test-response", model: "muse-spark-1.3", output } };
}
function input(generation = 1, text = "Hello", sessionId = "chat"): ConversationTurnInput {
	return {
		requestId: `${sessionId}-request-${generation}`,
		sessionId,
		turnId: `turn-${generation}`,
		generation,
		text,
	};
}
function identity(turn: ConversationTurnInput) {
	return { sessionId: turn.sessionId, turnId: turn.turnId, generation: turn.generation };
}
function mockClient(
	reply: (request: MetaRequest, signal: AbortSignal) => AsyncIterable<MetaStreamEvent>
) {
	const requests: MetaRequest[] = [];
	const client: AgentModelClient = {
		stream(request, signal) {
			requests.push(structuredClone(request));
			return reply(request, signal);
		},
	};
	return { client, requests };
}
function replies(text = "Hello there.") {
	return mockClient(async function* () {
		yield { type: "text", delta: text };
		yield end();
	});
}
async function finish(
	service: ConversationService,
	turn: ConversationTurnInput,
	status = "completed"
): Promise<PollTurnResult> {
	await eventually(() => service.poll(identity(turn)).status !== "running");
	const result = service.poll(identity(turn));
	assert.equal(result.status, status);
	assert.deepEqual(result.actions, []);
	assert(!result.events.some((event) => event.kind === "action"));
	return result;
}
function context(): ConversationPRContext {
	return {
		pr: {
			id: "selected-pr",
			repository: "test/project",
			number: 42,
			url: "https://github.com/test/project/pull/42",
			title: "Test-only selected context",
			author: "test-author",
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
		},
		description: "TEST CONTEXT: adjust timeout",
		files: [
			{
				path: "server.ts",
				status: "modified",
				additions: 1,
				deletions: 1,
				patch: "@@ -1 +1 @@\n-timeout = 5\n+timeout = 10",
			},
		],
		truncated: false,
	};
}

test("native client/router handle greeting and follow-up without a PR, screen or tools", async () => {
	const requests: Record<string, unknown>[] = [];
	const answers = ["Hello! What would you like to discuss?", "We were just saying hello."];
	const client = new MetaClient({
		getApiKey: async () => "test-only-key",
		recordUsage: () => {},
		fetch: async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)));
			const text = answers.shift();
			assert(text);
			return new Response(
				[
					{ type: "response.output_text.delta", delta: text },
					{
						type: "response.completed",
						response: {
							id: "test",
							model: "muse-spark-1.3",
							status: "completed",
							output: [],
							usage: { input_tokens: 10, output_tokens: 10 },
						},
					},
				]
					.map((value) => `data: ${JSON.stringify(value)}\n\n`)
					.join(""),
				{ headers: { "content-type": "text/event-stream" } }
			);
		},
	});
	const service = new ConversationService(client);
	const router = createConversationRouter(service).createCaller({});
	try {
		const first = input();
		await router.start(first);
		assert.equal((await finish(service, first)).text, "Hello! What would you like to discuss?");
		const second = input(2, "What were we talking about?");
		await router.start(second);
		assert.equal((await finish(service, second)).text, "We were just saying hello.");
		assert.deepEqual(requests[1]?.["input"], [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hello! What would you like to discuss?" },
			{ role: "user", content: second.text },
		]);
		for (const request of requests) {
			assert.deepEqual(request["tools"], []);
			const payload = JSON.stringify(request["input"]);
			for (const word of ["screenContext", "prId", "fixture", "scenario", "checkout"])
				assert(!payload.includes(word));
		}
		assert.equal((await router.poll(identity(second))).status, "completed");
		await router.release({ sessionId: first.sessionId });
		assert.equal(service.poll(identity(second)).status, "stale");
	} finally {
		await service.dispose();
	}
});

test("only completed real exchanges enter history, and sessions remain isolated", async () => {
	const mock = replies();
	const service = new ConversationService(mock.client);
	try {
		const first = input(1, "My favorite color is blue");
		service.start(first);
		await finish(service, first);
		const other = input(1, "Hello from another session", "other");
		service.start(other);
		await finish(service, other);
		assert.deepEqual(mock.requests[1]?.input, [{ role: "user", content: other.text }]);
		const next = input(2, "What color did I mention?");
		service.start(next);
		await finish(service, next);
		assert.deepEqual(mock.requests[2]?.input[0], { role: "user", content: first.text });
	} finally {
		await service.dispose();
	}
});

test("request retries deduplicate across later turns; conflicting IDs and stale generations reject", async () => {
	const mock = replies();
	const service = new ConversationService(mock.client);
	try {
		const first = input();
		const started = service.start(first);
		assert.deepEqual(service.start(first), started);
		await finish(service, first);
		const second = input(2);
		service.start(second);
		await finish(service, second);
		assert.equal(service.start(first).status, "completed");
		assert.equal(mock.requests.length, 2);
		assert.throws(() => service.start({ ...first, text: "different" }), /reused/);
		assert.throws(() => service.start({ ...first, requestId: "new" }), /stale/);
		assert.throws(() => service.start({ ...second, requestId: "new", generation: 3 }), /stale/);
		assert.throws(() => service.poll({ ...identity(second), afterSequence: 999 }));
	} finally {
		await service.dispose();
	}
});

test("explicit PR context is validated and refreshed; absent PR never calls context port or replays old patches", async () => {
	const mock = replies();
	let loads = 0;
	const service = new ConversationService(mock.client, {
		getContext: async (prId, signal) => {
			assert.equal(prId, "selected-pr");
			assert(!signal.aborted);
			loads++;
			return context();
		},
	});
	try {
		const first = input();
		service.start(first);
		await finish(service, first);
		assert.equal(loads, 0);
		const selected = { ...input(2, "Explain this change"), prId: "selected-pr" };
		service.start(selected);
		await finish(service, selected);
		assert.equal(loads, 1);
		assert(JSON.stringify(mock.requests[1]?.input).includes("timeout = 10"));
		const next = input(3, "Now let's talk about something else");
		service.start(next);
		await finish(service, next);
		assert.equal(loads, 1);
		assert(!JSON.stringify(mock.requests[2]?.input).includes("timeout = 10"));
		service.start({ ...input(4), prId: "selected-pr" });
		await finish(service, input(4));
		assert.equal(loads, 2);
	} finally {
		await service.dispose();
	}
});

test("wrong, unavailable or failed PR context errors safely without sending ungrounded inference", async () => {
	for (const getContext of [
		undefined,
		async () => ({ ...context(), pr: { ...context().pr, id: "wrong" } }),
		async () => {
			throw new Error("SECRET context failure");
		},
	]) {
		const mock = replies();
		const service = new ConversationService(mock.client, { getContext });
		try {
			const turn = { ...input(), prId: "selected-pr" };
			service.start(turn);
			const result = await finish(service, turn, "error");
			assert.equal(mock.requests.length, 0);
			assert(
				result.events.some((e) => e.kind === "error" && e.message.includes("continue without a PR"))
			);
			assert(!JSON.stringify(result).includes("SECRET"));
		} finally {
			await service.dispose();
		}
	}
});

test("context budget omits patches honestly and leaves the supplied snapshot untouched", async () => {
	const original = context();
	const file = original.files[0];
	assert(file);
	original.files = Array.from({ length: 100 }, (_, i) => ({
		...file,
		path: `${i}.ts`,
		patch: "p".repeat(20_000),
	}));
	const mock = replies();
	const service = new ConversationService(mock.client, { getContext: async () => original });
	try {
		const turn = { ...input(), prId: "selected-pr" };
		service.start(turn);
		await finish(service, turn);
		const reference = mock.requests[0]?.input[0]?.["content"] as { text: string }[];
		const sent = JSON.parse(reference[0]?.text ?? "{}").selectedPullRequest;
		assert(sent.truncated);
		assert(JSON.stringify(sent).length <= 96_000);
		assert(sent.files.some((file: { patch?: string }) => file.patch === undefined));
		assert.equal(original.truncated, false);
		assert.equal(original.files[99]?.patch?.length, 20_000);
	} finally {
		await service.dispose();
	}
});

test("history drops whole old exchanges at both count and character limits", async () => {
	for (const size of [10, 6000]) {
		const mock = replies("a".repeat(size));
		const service = new ConversationService(mock.client);
		try {
			for (let i = 1; i <= 16; i++) {
				const turn = input(i, `message-${i}: ${"u".repeat(size)}`);
				service.start(turn);
				await finish(service, turn);
			}
			const history = mock.requests.at(-1)?.input.slice(0, -1) ?? [];
			assert(history.length <= 24);
			assert.equal(history.length % 2, 0);
			assert(history.reduce((sum, item) => sum + String(item["content"]).length, 0) <= 64_000);
			assert(!String(history[0]?.["content"]).startsWith("message-1:"));
			assert.equal(history.at(-1)?.["role"], "assistant");
		} finally {
			await service.dispose();
		}
	}
});

test("cancel and replacement suppress late ignored-abort provider data and exclude partial history", async () => {
	let release: (() => void) | undefined;
	let providerSignal: AbortSignal | undefined;
	const mock = mockClient(async function* (request, signal) {
		if (request.requestId === "chat-request-1") {
			providerSignal = signal;
			yield { type: "text", delta: "Partial" };
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			yield { type: "text", delta: "LATE" };
			yield end();
		} else {
			yield { type: "text", delta: "New reply" };
			yield end();
		}
	});
	const service = new ConversationService(mock.client);
	try {
		const first = input();
		service.start(first);
		await eventually(() => release !== undefined);
		assert.equal(
			service.cancel({
				...identity(first),
				requestId: "wrong-cancel",
				generation: 99,
				reason: "user",
			}).status,
			"stale"
		);
		assert.equal(
			service.cancel({ ...identity(first), requestId: "cancel", reason: "user" }).status,
			"cancelled"
		);
		assert(providerSignal?.aborted);
		const second = input(2, "A fresh question");
		service.start(second);
		release?.();
		assert.equal((await finish(service, second)).text, "New reply");
		assert.equal(service.poll(identity(first)).status, "stale");
		assert.deepEqual(mock.requests[1]?.input, [{ role: "user", content: second.text }]);
	} finally {
		release?.();
		await service.dispose();
	}
});

test("generation replacement cancels context lookup; release and dispose stop uncooperative operations", async () => {
	let contextSignal: AbortSignal | undefined;
	const mock = replies();
	const service = new ConversationService(mock.client, {
		getContext: (_prId, signal) => {
			contextSignal = signal;
			return new Promise(() => {});
		},
	});
	const first = { ...input(), prId: "selected-pr" };
	service.start(first);
	const second = input(2);
	service.start(second);
	assert(contextSignal?.aborted);
	await finish(service, second);
	service.releaseSession(" chat ");
	assert.equal(service.poll(identity(second)).status, "stale");
	service.start(input());
	await finish(service, input());
	assert.deepEqual(mock.requests.at(-1)?.input, [{ role: "user", content: "Hello" }]);
	await service.dispose();
	assert.throws(() => service.start(input(3)), /disposed/);
	const stalled = mockClient(() => ({
		[Symbol.asyncIterator]: () => ({
			next: () => new Promise(() => {}),
			return: () => new Promise(() => {}),
		}),
	}));
	const waiting = new ConversationService(stalled.client);
	waiting.start(input());
	await waiting.dispose();
	assert.equal(waiting.poll(identity(input())).status, "stale");
});

test("completed text fallback works; incomplete or tool replies never become successful history", async () => {
	const mock = mockClient(async function* (request) {
		if (request.requestId.endsWith("-1"))
			yield end([
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Terminal reply" }],
				},
			]);
		else if (request.requestId.endsWith("-2")) yield { type: "text", delta: "Unfinished" };
		else if (request.requestId.endsWith("-3"))
			yield end([{ type: "function_call", name: "post_comment" }]);
		else {
			yield { type: "text", delta: "Next" };
			yield end();
		}
	});
	const service = new ConversationService(mock.client);
	try {
		service.start(input());
		assert.equal((await finish(service, input())).text, "Terminal reply");
		for (const i of [2, 3]) {
			service.start(input(i));
			await finish(service, input(i), "error");
		}
		service.start(input(4));
		await finish(service, input(4));
		assert.deepEqual(mock.requests[3]?.input, [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Terminal reply" },
			{ role: "user", content: "Hello" },
		]);
	} finally {
		await service.dispose();
	}
});

test("poll pages stay bounded and recover full text after event compaction", async () => {
	const mock = mockClient(async function* () {
		for (let i = 0; i < 600; i++) yield { type: "text", delta: "x" };
		yield end();
	});
	const service = new ConversationService(mock.client);
	try {
		const turn = input();
		service.start(turn);
		const result = await finish(service, turn);
		assert.equal(result.sequence, 602);
		assert.equal(result.text.length, 600);
		assert.equal(result.events.length, 100);
		let cursor = 0;
		const sequences: number[] = [];
		while (cursor < result.sequence) {
			const page = service.poll({ ...identity(turn), afterSequence: cursor, limit: 37 });
			assert(page.events.length > 0 && page.events.length <= 37);
			assert.equal(page.text.length, 600);
			sequences.push(...page.events.map((e) => e.sequence));
			const last = page.events.at(-1);
			assert(last);
			cursor = last.sequence;
		}
		assert.equal(sequences.length, 512);
		assert.equal(new Set(sequences).size, 512);
	} finally {
		await service.dispose();
	}
});

test("safe provider failures give actionable categories without echoing credentials or server text", async () => {
	for (const [error, expected] of [
		[new MetaApiError("Meta credential unavailable: SECRET"), "API key"],
		[new MetaApiError("SECRET", 401), "API key"],
		[new MetaApiError("SECRET", 403), "model access"],
		[new MetaApiError("SECRET", 429), "quota"],
		[new MetaApiError("SECRET", 503), "temporarily unavailable"],
		[new DOMException("SECRET", "TimeoutError"), "timed out"],
		[new TypeError("SECRET"), "connection"],
		[new Error("SECRET"), "try again"],
	] as const) {
		const mock = mockClient(() => {
			throw error;
		});
		const service = new ConversationService(mock.client);
		try {
			const turn = input();
			service.start(turn);
			const result = await finish(service, turn, "error");
			assert(!JSON.stringify(result).includes("SECRET"));
			assert(result.events.some((e) => e.kind === "error" && e.message.includes(expected)));
		} finally {
			await service.dispose();
		}
	}
});
