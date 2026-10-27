import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	AgentAction,
	ConversationActionReceipt,
	ConversationTurnInput,
	PreparedReview,
	ReviewNavigation,
	ReviewProgress,
	ReviewScreen,
} from "../../shared/contracts";
import { type ConversationOptions, ConversationService } from "./conversation";
import { createConversationRouter } from "./conversation-router";
import type { ConversationReviewPorts, ReviewNavigationRequest } from "./guided-review";
import type { AgentModelClient, MetaItem, MetaRequest } from "./meta-client";
import { eventually } from "./test-support";

function plan(): PreparedReview {
	return {
		id: "test-review",
		version: 1,
		pr: {
			id: "test-pr",
			repository: "test/repo",
			number: 1,
			url: "https://github.com/test/repo/pull/1",
			title: "TEST ONLY",
			author: "test",
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
		},
		createdAt: "2026-10-27T00:00:00Z",
		summary: "Inferred: service change",
		orderRationale: "Inferred: service before tests",
		coverage: "complete",
		evidence: "inferred-from-github",
		files: [
			{
				path: "service.ts",
				reason: "Inferred: behavior first",
				summary: "Inferred: changes timeout",
				suggestedComments: [],
			},
			{
				path: "test.ts",
				reason: "Inferred: verifies behavior next",
				summary: "Inferred: adjusts assertion",
				suggestedComments: [],
			},
		],
	};
}
function call(name: string, args: unknown = {}, id = name): MetaItem {
	return {
		type: "function_call",
		call_id: id,
		name,
		arguments: JSON.stringify(args),
		status: "completed",
	};
}
function harness(outputs: MetaItem[][], timeoutMs = 1000) {
	const prepared = plan();
	const input: ConversationTurnInput = {
		sessionId: "test-chat",
		requestId: "test-request",
		turnId: "test-turn",
		generation: 1,
		text: "Walk me through the review",
		prId: prepared.pr.id,
		screen: { sequence: 3, mode: "conversation", prId: prepared.pr.id },
	};
	let current: ReviewScreen = structuredClone(input.screen as ReviewScreen);
	let progress: ReviewProgress | null = null;
	const requests: MetaRequest[] = [];
	const navigations: ReviewNavigationRequest[] = [];
	const commits: ConversationActionReceipt[] = [];
	const client: AgentModelClient = {
		async *stream(request) {
			requests.push(structuredClone(request));
			const output = outputs.shift();
			assert(output, "Unexpected extra inference");
			yield {
				type: "text",
				delta: output.length ? "PRETOOL FILLER MUST NOT SPEAK" : "This file changes the timeout.",
			};
			yield {
				type: "completed",
				response: { id: "test-response", model: "muse-spark-1.3", output },
			};
		},
	};
	const ports: ConversationReviewPorts = {
		getReady: async () => prepared,
		getProgress: async () => progress,
		getScreen: async () => structuredClone(current),
		navigate: async (_id, request) => {
			navigations.push(request);
			const path = request.path ?? (request.direction === "next" ? "test.ts" : "service.ts");
			return {
				reviewId: prepared.id,
				prId: prepared.pr.id,
				baseSha: prepared.pr.baseSha,
				headSha: prepared.pr.headSha,
				path,
				paused: request.direction === "pause",
				...(request.line
					? {
							highlight: {
								repository: prepared.pr.repository,
								revision: request.side ?? "head",
								commitSha: request.side === "base" ? prepared.pr.baseSha : prepared.pr.headSha,
								path,
								startLine: request.line,
								endLine: request.line,
							},
						}
					: {}),
			};
		},
	};
	const commit = (receipt: ConversationActionReceipt, navigation: ReviewNavigation) => {
		current = structuredClone(receipt.screen);
		commits.push(receipt);
		progress = {
			reviewId: prepared.id,
			prId: prepared.pr.id,
			baseSha: prepared.pr.baseSha,
			headSha: prepared.pr.headSha,
			path: navigation.path,
			paused: navigation.paused,
			visited: [navigation.path],
			updatedAt: "2026-10-27T00:00:01Z",
		};
	};
	const options: ConversationOptions = {
		review: ports,
		actionReceipts: { timeoutMs, updateScreen: commit },
	};
	const service = new ConversationService(client, options);
	const identity = {
		sessionId: input.sessionId,
		turnId: input.turnId,
		generation: input.generation,
	};
	const poll = () => service.poll(identity);
	const action = async () => {
		await eventually(() => poll().actions.length > 0);
		const value = poll().actions.at(-1);
		assert(value?.kind === "review-navigation");
		return value;
	};
	const receipt = (action: AgentAction): ConversationActionReceipt => {
		assert(action.kind === "review-navigation");
		const nav = action.navigation;
		return {
			...identity,
			requestId: action.requestId,
			status: "applied",
			screen: {
				sequence: current.sequence + 1,
				mode: "review",
				prId: nav.prId,
				reviewId: nav.reviewId,
				baseSha: nav.baseSha,
				headSha: nav.headSha,
				path: nav.path,
				paused: nav.paused,
			},
		};
	};
	return {
		service,
		input,
		identity,
		poll,
		action,
		receipt,
		ports,
		options,
		requests,
		navigations,
		commits,
		prepared,
		commit,
		setScreen(value: ReviewScreen) {
			current = value;
		},
	};
}
async function finish(h: ReturnType<typeof harness>, status = "completed") {
	await eventually(() => h.poll().status !== "running");
	assert.equal(h.poll().status, status);
	return h.poll();
}

test("no selected PR preserves ordinary conversation despite configured review ports", async () => {
	const h = harness([[]]);
	let read = false;
	h.ports.getReady = async () => {
		read = true;
		throw new Error("Not relevant to greeting");
	};
	try {
		const { prId: _prId, screen: _screen, ...input } = h.input;
		h.service.start({ ...input, text: "Hello" });
		await finish(h);
		assert.equal(read, false);
		assert.deepEqual(h.poll().actions, []);
		assert.deepEqual(h.requests[0]?.tools, []);
		assert.deepEqual(h.requests[0]?.input, [{ role: "user", content: "Hello" }]);
	} finally {
		await h.service.dispose();
	}
});

test("ready inspection uses cached plan/current file and unavailable preparation is never fabricated", async () => {
	for (const ready of [true, false]) {
		const h = harness([[call("inspect_ready_review")], []]);
		if (!ready)
			h.ports.getReady = async () => {
				throw new Error("Queued SECRET");
			};
		try {
			h.service.start(h.input);
			await finish(h);
			assert.equal(h.navigations.length, 0);
			assert.deepEqual(h.poll().actions, []);
			assert(h.requests.every((request) => request.workload === "quick"));
			const history = h.requests[1]?.input ?? [];
			const result = history.find((item) => item["type"] === "function_call_output");
			assert.equal(JSON.parse(String(result?.["output"])).status, ready ? "ready" : "unavailable");
			assert(!JSON.stringify(history).includes("SECRET"));
		} finally {
			await h.service.dispose();
		}
	}
});

test("all navigation tools wait for matching applied receipt before dependent narration", async () => {
	for (const [name, args, expected] of [
		[
			"open_review_file",
			{ path: "test.ts", line: 7, side: "base" },
			{ path: "test.ts", line: 7, side: "base" },
		],
		["next_review_file", {}, { direction: "next" }],
		["previous_review_file", {}, { direction: "previous" }],
		["pause_review", {}, { direction: "pause" }],
		["resume_review", {}, { direction: "resume" }],
	] as const) {
		const h = harness([[call(name, args)], []]);
		try {
			h.service.start(h.input);
			const action = await h.action();
			assert.equal(h.requests.length, 1);
			assert.equal(h.poll().text, "");
			assert(!h.poll().events.some((event) => event.kind === "text-delta"));
			assert.deepEqual(h.navigations, [expected]);
			const caller = createConversationRouter(h.service).createCaller({});
			assert.deepEqual(await caller.actionApplied(h.receipt(action)), { status: "accepted" });
			assert.equal((await finish(h)).text, "This file changes the timeout.");
			assert.equal(h.requests.length, 2);
			assert.equal(h.commits.length, 1);
			assert(!JSON.stringify(h.requests[1]?.input).includes("PRETOOL FILLER"));
			const toolResult = h.requests[1]?.input.find(
				(item) => item["type"] === "function_call_output"
			);
			assert.equal(JSON.parse(String(toolResult?.["output"])).status, "applied");
		} finally {
			await h.service.dispose();
		}
	}
});

test("async screen/progress commit is awaited and duplicate or mismatched receipts cannot release it", async () => {
	const h = harness([[call("next_review_file")], []]);
	let resolve: (() => void) | undefined;
	const receiptOptions = h.options.actionReceipts;
	assert(receiptOptions);
	receiptOptions.updateScreen = async (receipt, nav, signal) => {
		await new Promise<void>((done) => {
			resolve = done;
		});
		signal.throwIfAborted();
		h.commit(receipt, nav);
	};
	try {
		h.service.start(h.input);
		const action = await h.action();
		const receipt = h.receipt(action);
		for (const patch of [
			{ requestId: "foreign" },
			{ turnId: "foreign" },
			{ generation: 99 },
			{ screen: { ...receipt.screen, path: "service.ts" } },
			{ screen: { ...receipt.screen, headSha: "e".repeat(40) } },
			{ screen: { ...receipt.screen, mode: "conversation" } },
		])
			assert.deepEqual(await h.service.actionApplied({ ...receipt, ...patch }), {
				status: "stale",
			});
		const committing = h.service.actionApplied(receipt);
		await eventually(() => resolve !== undefined);
		assert.equal(h.requests.length, 1);
		assert.equal(h.poll().text, "");
		assert.deepEqual(await h.service.actionApplied(receipt), { status: "stale" });
		resolve?.();
		assert.deepEqual(await committing, { status: "accepted" });
		await finish(h);
		assert.equal(h.commits.length, 1);
	} finally {
		resolve?.();
		await h.service.dispose();
	}
});

test("manual navigation during a pending navigation suppresses the stale effect", async () => {
	const h = harness([[call("next_review_file")]]);
	const original = h.ports.navigate;
	h.ports.navigate = async (...args) => {
		const result = await original(...args);
		h.setScreen({ sequence: 99, mode: "conversation", prId: h.prepared.pr.id });
		return result;
	};
	try {
		h.service.start(h.input);
		await finish(h, "error");
		assert.deepEqual(h.poll().actions, []);
		assert.equal(h.requests.length, 1);
	} finally {
		await h.service.dispose();
	}
});

test("ignored/cancelled/timed-out receipts stop narration and reject late delivery", async () => {
	for (const mode of ["ignored", "cancel", "timeout"] as const) {
		const h = harness([[call("next_review_file")]], mode === "timeout" ? 20 : 1000);
		try {
			h.service.start(h.input);
			const action = await h.action();
			const receipt = h.receipt(action);
			if (mode === "ignored") await h.service.actionApplied({ ...receipt, status: "ignored" });
			if (mode === "cancel")
				h.service.cancel({ ...h.identity, requestId: "cancel", reason: "user" });
			await finish(h, mode === "cancel" ? "cancelled" : "error");
			assert.equal(h.requests.length, 1);
			assert.equal(h.poll().text, "");
			assert.deepEqual(await h.service.actionApplied(receipt), { status: "stale" });
		} finally {
			await h.service.dispose();
		}
	}
});

test("cancellation and timeout abort an in-flight persistence callback before it can commit", async () => {
	for (const mode of ["cancel", "timeout"] as const) {
		const h = harness([[call("next_review_file")]], mode === "timeout" ? 25 : 1000);
		let resolve: (() => void) | undefined;
		let signal: AbortSignal | undefined;
		const options = h.options.actionReceipts;
		assert(options);
		options.updateScreen = async (receipt, navigation, active) => {
			signal = active;
			await new Promise<void>((done) => {
				resolve = done;
			});
			active.throwIfAborted();
			h.commit(receipt, navigation);
		};
		try {
			h.service.start(h.input);
			const action = await h.action();
			const committing = h.service.actionApplied(h.receipt(action));
			await eventually(() => resolve !== undefined);
			if (mode === "cancel")
				h.service.cancel({ ...h.identity, requestId: "cancel", reason: "user" });
			await finish(h, mode === "cancel" ? "cancelled" : "error");
			assert(signal?.aborted);
			resolve?.();
			assert.deepEqual(await committing, { status: "stale" });
			assert.equal(h.commits.length, 0);
		} finally {
			resolve?.();
			await h.service.dispose();
		}
	}
});

test("foreign cached plans/progress and fabricated path or navigation revisions cannot produce effects", async () => {
	for (const mode of ["plan", "progress", "path", "navigation"] as const) {
		const h = harness([
			[call("open_review_file", { path: mode === "path" ? "unknown.ts" : "service.ts" })],
		]);
		if (mode === "plan") h.prepared.pr.id = "foreign";
		if (mode === "progress")
			h.ports.getProgress = async () => ({
				reviewId: h.prepared.id,
				prId: h.prepared.pr.id,
				baseSha: h.prepared.pr.baseSha,
				headSha: "e".repeat(40),
				path: "service.ts",
				paused: false,
				visited: [],
				updatedAt: "2026-10-27T00:00:00Z",
			});
		if (mode === "navigation") {
			const original = h.ports.navigate;
			h.ports.navigate = async (...args) => ({
				...(await original(...args)),
				headSha: "e".repeat(40),
			});
		}
		try {
			h.service.start(h.input);
			await finish(h, "error");
			assert.deepEqual(h.poll().actions, []);
		} finally {
			await h.service.dispose();
		}
	}
});
