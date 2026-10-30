import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	AgentAction,
	AttentionClaim,
	ConversationAttentionInput,
	ConversationTurnInput,
	TurnIdentity,
} from "../../shared/contracts";
import { type ConversationOptions, ConversationService } from "./conversation";
import { createConversationRouter } from "./conversation-router";
import type { AgentModelClient, MetaItem, MetaRequest, MetaStreamEvent } from "./meta-client";
import { call, eventually } from "./test-support";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
function input(generation = 1, claimId = `claim-${generation}`): ConversationAttentionInput {
	return {
		sessionId: "session",
		turnId: `turn-${generation}`,
		generation,
		requestId: `request-${generation}`,
		claimId,
	};
}
function user(generation: number, text = "What decision?"): ConversationTurnInput {
	const { claimId: _, ...identity } = input(generation);
	return { ...identity, text };
}
function identity(input: TurnIdentity): TurnIdentity {
	return { sessionId: input.sessionId, turnId: input.turnId, generation: input.generation };
}
function claim(input: ConversationAttentionInput): AttentionClaim {
	return {
		id: input.claimId,
		sessionId: input.sessionId,
		createdAt: new Date(Date.now() - 1000).toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		items: [
			{
				noticeId: "notice",
				jobId: "job",
				kind: "decision",
				repository: "test/repo",
				label: "MET-50",
				headSha: "a".repeat(40),
				decisionId: "decision",
				question: "Which real option?",
				changedFileCount: 2,
				applied: false,
			},
		],
	};
}
function end(output: MetaItem[] = []): MetaStreamEvent {
	return { type: "completed", response: { id: "test", model: "muse-spark-1.3", output } };
}
function harness(options: ConversationOptions = {}, reply?: AgentModelClient["stream"]) {
	const requests: MetaRequest[] = [];
	const signals: AbortSignal[] = [];
	let resolutions = 0;
	const client: AgentModelClient = {
		stream(request, signal) {
			requests.push(structuredClone(request));
			signals.push(signal);
			return reply
				? reply(request, signal)
				: (async function* () {
						yield { type: "text" as const, delta: "MET-50 needs your decision." };
						yield end();
					})();
		},
	};
	const service = new ConversationService(client, {
		narrationReceipts: { timeoutMs: 1000 },
		attention: {
			resolve: async (input) => {
				resolutions++;
				return claim(input);
			},
		},
		...options,
	});
	return { service, requests, signals, resolutions: () => resolutions };
}
async function checkpoint(service: ConversationService, input: TurnIdentity) {
	await eventually(() => service.poll(identity(input)).actions.length > 0);
	const action = service.poll(identity(input)).actions[0];
	assert(action?.kind === "narration-checkpoint");
	return action;
}
function receipt(service: ConversationService, action: AgentAction, status = "spoken") {
	return service.narrationApplied({ ...identity(action), requestId: action.requestId, status });
}
async function terminal(service: ConversationService, turn: TurnIdentity, status = "completed") {
	await eventually(() => service.poll(identity(turn)).status !== "running");
	assert.equal(service.poll(identity(turn)).status, status);
}

test("router admits an assistant-only notice; poll completion requires exact delivered receipt", async () => {
	const h = harness();
	const router = createConversationRouter(h.service).createCaller({});
	try {
		assert.equal(h.service.isBusy("session"), false);
		await assert.rejects(
			router.attend({ ...input(), text: "fake user" } as ConversationAttentionInput)
		);
		assert.equal(h.resolutions(), 0);
		const started = await router.attend(input());
		assert.equal(started.status, "running");
		const action = await checkpoint(h.service, input());
		const poll = await router.poll(identity(input()));
		assert.equal(poll.status, "running");
		assert.equal(h.service.isBusy("session"), true);
		assert.equal(h.service.attentionCompleted(input(), input().claimId), false);
		assert.equal(poll.text, "MET-50 needs your decision.");
		assert.equal(action.throughTextLength, poll.text.length);
		assert.equal(action.screenSequence, 0);
		assert(
			!poll.events.some((event) => event.kind === "acknowledgement" || event.kind === "completed")
		);
		assert.deepEqual(h.requests[0]?.tools, []);
		assert.equal(h.requests[0]?.maxOutputTokens, 512);
		assert.deepEqual(
			h.requests[0]?.input.map((item) => item["role"]),
			["developer"]
		);
		const packet = JSON.parse(String(h.requests[0]?.input.at(-1)?.["content"]));
		assert.equal(packet.assistantInitiatedAttention.items[0].decisionId, "decision");
		for (const wrong of [
			{ generation: 99 },
			{ turnId: "foreign" },
			{ requestId: "foreign" },
			{ sessionId: "foreign" },
		]) {
			assert.equal(
				h.service.narrationApplied({
					...identity(action),
					requestId: action.requestId,
					status: "spoken",
					...wrong,
				}).status,
				"stale"
			);
		}
		assert.equal(receipt(h.service, action).status, "accepted");
		// Completion is synchronous at acceptance, without waiting for the model job's microtask.
		assert.equal(h.service.attentionCompleted(input(), input().claimId), true);
		assert.equal(h.service.isBusy("session"), false);
		assert.equal(receipt(h.service, action).status, "stale");
		await terminal(h.service, input());
		assert.equal(h.service.attentionCompleted(input(), "another-claim"), false);
	} finally {
		await h.service.dispose();
	}
});

test("delivered notice enters real history once and preserves completion across immediate user followup", async () => {
	const h = harness();
	try {
		h.service.start(user(1, "Keep reviewing this file"));
		await terminal(h.service, user(1));
		const attention = input(2);
		h.service.attend(attention);
		const action = await checkpoint(h.service, attention);
		assert.deepEqual(h.requests[1]?.input.slice(0, -1), [
			{ role: "user", content: "Keep reviewing this file" },
			{ role: "assistant", content: "MET-50 needs your decision." },
		]);
		receipt(h.service, action);
		h.service.start(user(3));
		await terminal(h.service, user(3));
		assert.equal(h.service.attentionCompleted(attention, attention.claimId), true);
		assert.deepEqual(h.requests[2]?.input, [
			{ role: "user", content: "Keep reviewing this file" },
			{ role: "assistant", content: "MET-50 needs your decision." },
			{ role: "assistant", content: "MET-50 needs your decision." },
			{ role: "user", content: "What decision?" },
		]);
		assert(h.requests[2]?.instructions.includes('"decisionId":"decision"'));
		assert(h.requests[2]?.instructions.includes('"delivery":"delivered"'));
		assert.equal(h.service.attend(attention).status, "completed");
		assert.equal(h.requests.length, 3);
	} finally {
		await h.service.dispose();
	}
});

test("attention completion distinguishes spoken from displayed delivery across later turns", async () => {
	for (const delivery of ["spoken", "displayed"] as const) {
		const h = harness();
		const other = delivery === "spoken" ? "displayed" : "spoken";
		try {
			h.service.attend(input());
			const action = await checkpoint(h.service, input());
			assert.equal(h.service.attentionCompleted(input(), input().claimId, delivery), false);
			assert.equal(receipt(h.service, action, delivery).status, "accepted");
			assert.equal(h.service.attentionCompleted(input(), input().claimId), true);
			assert.equal(h.service.attentionCompleted(input(), input().claimId, delivery), true);
			assert.equal(h.service.attentionCompleted(input(), input().claimId, other), false);
			// A duplicate receipt with another delivery status cannot upgrade the proof.
			assert.equal(receipt(h.service, action, other).status, "stale");
			h.service.start(user(2));
			await terminal(h.service, user(2));
			assert.equal(h.service.attentionCompleted(input(), input().claimId), true);
			assert.equal(h.service.attentionCompleted(input(), input().claimId, delivery), true);
			assert.equal(h.service.attentionCompleted(input(), input().claimId, other), false);
			h.service.releaseSession(input().sessionId);
			assert.equal(h.service.attentionCompleted(input(), input().claimId, delivery), false);
		} finally {
			await h.service.dispose();
		}
	}
});

test("busy attention admission leaves user identity, events, cancellation and retry state untouched", async () => {
	const pending = deferred<void>();
	const h = harness({}, async function* (request) {
		if (request.requestId === "request-1") await pending.promise;
		yield { type: "text", delta: "Answer" };
		yield end();
	});
	try {
		h.service.start(user(1));
		const before = h.service.poll(identity(user(1)));
		assert.throws(() => h.service.attend(input(2)), /busy/);
		assert.deepEqual(h.service.poll(identity(user(1))), before);
		assert.equal(h.resolutions(), 0);
		assert.equal(h.signals[0]?.aborted, false);
		pending.resolve();
		await terminal(h.service, user(1));
		h.service.attend(input(2));
		receipt(h.service, await checkpoint(h.service, input(2)));
		assert.equal(h.service.attentionCompleted(input(2), input(2).claimId), true);
	} finally {
		pending.resolve();
		await h.service.dispose();
	}
});

test("followup retains exact earlier notice identities after a later notice changes attention focus", async () => {
	const h = harness({
		attention: {
			resolve: async (input) => {
				const value = claim(input);
				const item = value.items[0];
				assert(item);
				item.noticeId = `notice-${input.generation}`;
				item.jobId = `job-${input.generation}`;
				item.decisionId = `decision-${input.generation}`;
				return value;
			},
		},
	});
	try {
		for (const generation of [1, 2]) {
			const notice = input(generation);
			h.service.attend(notice);
			receipt(h.service, await checkpoint(h.service, notice));
		}
		h.service.start(user(3, "The first decision, please"));
		await terminal(h.service, user(3));
		const request = h.requests[2];
		assert(request);
		for (const id of ["notice-1", "job-1", "decision-1", "notice-2", "job-2", "decision-2"])
			assert(request.instructions.includes(id));
		assert.deepEqual(
			request.input.map((item) => item["role"]),
			["assistant", "assistant", "user"]
		);
		assert.equal(request.input.at(-1)?.["content"], "The first decision, please");
	} finally {
		await h.service.dispose();
	}
});

test("attention request retries deduplicate, conflict with user IDs and cannot replay an admitted claim", async () => {
	const h = harness();
	try {
		const started = h.service.attend(input());
		assert.deepEqual(h.service.attend(input()), started);
		const action = await checkpoint(h.service, input());
		assert.throws(() => h.service.attend({ ...input(), claimId: "different" }), /reused/);
		assert.throws(() => h.service.start({ ...user(2), requestId: input().requestId }), /reused/);
		receipt(h.service, action);
		assert.throws(
			() => h.service.attend({ ...input(2), claimId: input().claimId }),
			/already admitted/
		);
		assert.throws(() => h.service.attend({ ...input(2), generation: 1 }), /stale/);
		assert.throws(() => h.service.attend({ ...input(2), turnId: input().turnId }), /stale/);
		assert.equal(h.resolutions(), 1);
		assert.equal(h.requests.length, 1);
		assert.equal(h.service.attend(input()).status, "completed");
	} finally {
		await h.service.dispose();
	}
});

test("user preemption cancels resolver, validation or model work and rejects ignored-abort late output", async () => {
	for (const phase of ["resolve", "validate", "model", "after-model"] as const) {
		const held = deferred<void>();
		let entered = false;
		let signal: AbortSignal | undefined;
		let validations = 0;
		const pause = async (active: AbortSignal) => {
			entered = true;
			signal = active;
			await held.promise;
		};
		const h = harness(
			{
				attention: {
					resolve: async (input, active) => {
						if (phase === "resolve") await pause(active);
						return claim(input);
					},
					validate: async (_input, active) => {
						validations++;
						if (phase === "validate" || (phase === "after-model" && validations === 2))
							await pause(active);
					},
				},
			},
			async function* (request, active) {
				if (request.requestId === input().requestId && phase === "model") await pause(active);
				yield {
					type: "text",
					delta: request.requestId === input().requestId ? "Late notice" : "Real user answer",
				};
				yield end();
			}
		);
		try {
			h.service.attend(input());
			await eventually(() => entered);
			h.service.start(user(2));
			assert(signal?.aborted);
			held.resolve();
			await terminal(h.service, user(2));
			assert.equal(h.service.attentionCompleted(input(), input().claimId), false);
			assert.equal(h.service.poll(identity(input())).status, "stale");
			assert.equal(h.service.attend(input()).status, "cancelled");
			assert.deepEqual(h.requests.at(-1)?.input, [{ role: "user", content: "What decision?" }]);
		} finally {
			held.resolve();
			await h.service.dispose();
		}
	}
});

test("barge-in during notice delivery keeps unconfirmed attention focus without adding fake history", async () => {
	const h = harness();
	try {
		h.service.attend(input());
		const action = await checkpoint(h.service, input());
		h.service.start(user(2));
		assert.equal(receipt(h.service, action).status, "stale");
		await terminal(h.service, user(2));
		assert.equal(h.service.attentionCompleted(input(), input().claimId), false);
		assert.deepEqual(h.requests[1]?.input, [{ role: "user", content: "What decision?" }]);
		assert(h.requests[1]?.instructions.includes('"delivery":"interrupted"'));
		assert(h.requests[1]?.instructions.includes('"noticeId":"notice"'));
		assert(h.requests[1]?.instructions.includes("MET-50 needs your decision."));
	} finally {
		await h.service.dispose();
	}
});

test("ignored and timed-out delivery never prove completion or enter completed history", async () => {
	for (const mode of ["ignored", "timeout"] as const) {
		const h = harness({ narrationReceipts: { timeoutMs: mode === "timeout" ? 10 : 1000 } });
		try {
			h.service.attend(input());
			const action = await checkpoint(h.service, input());
			if (mode === "ignored")
				assert.equal(receipt(h.service, action, "ignored").status, "accepted");
			await terminal(h.service, input(), "error");
			assert.equal(h.service.attentionCompleted(input(), input().claimId), false);
			assert.equal(receipt(h.service, action).status, "stale");
			h.service.start(user(2));
			await terminal(h.service, user(2));
			assert.deepEqual(h.requests[1]?.input, [{ role: "user", content: "What decision?" }]);
		} finally {
			await h.service.dispose();
		}
	}
});

test("cancellation, release and dispose stop uncooperative resolvers and clear delivery proof", async () => {
	for (const mode of ["cancel", "release", "dispose"] as const) {
		let signal: AbortSignal | undefined;
		const h = harness({
			attention: {
				resolve: (_input, active) => {
					signal = active;
					return new Promise(() => {});
				},
			},
		});
		try {
			h.service.attend(input());
			assert(signal);
			if (mode === "cancel")
				h.service.cancel({ ...identity(input()), requestId: "cancel", reason: "user" });
			else if (mode === "release") h.service.releaseSession("session");
			else await h.service.dispose();
			assert(signal.aborted);
			assert.equal(h.service.isBusy("session"), false);
			assert.equal(h.service.attentionCompleted(input(), input().claimId), false);
			assert.equal(
				h.service.poll(identity(input())).status,
				mode === "cancel" ? "cancelled" : "stale"
			);
		} finally {
			await h.service.dispose();
		}
	}
	const h = harness();
	h.service.attend(input());
	receipt(h.service, await checkpoint(h.service, input()));
	assert(h.service.attentionCompleted(input(), input().claimId));
	h.service.releaseSession("session");
	assert.equal(h.service.attentionCompleted(input(), input().claimId), false);
	await h.service.dispose();
	assert.throws(() => h.service.attend(input()), /disposed/);
});

test("wrong, expired and malformed claims fail before inference; failed revalidation hides generated text", async () => {
	for (const fault of [
		"session",
		"id",
		"expiry",
		"future",
		"malformed",
		"before",
		"after",
	] as const) {
		let validates = 0;
		const h = harness({
			attention: {
				resolve: async (input) => {
					const value = claim(input);
					if (fault === "session") value.sessionId = "foreign";
					if (fault === "id") value.id = "foreign";
					if (fault === "expiry") value.expiresAt = new Date(Date.now() - 1).toISOString();
					if (fault === "future") value.createdAt = new Date(Date.now() + 120_000).toISOString();
					if (fault === "malformed") value.items = [];
					return value;
				},
				validate: async () => {
					validates++;
					if (fault === "before" || (fault === "after" && validates === 2))
						throw new Error("PRIVATE root state changed");
				},
			},
		});
		try {
			h.service.attend(input());
			await terminal(h.service, input(), "error");
			assert.equal(h.requests.length, fault === "after" ? 1 : 0);
			assert.equal(h.service.poll(identity(input())).text, "");
			assert.deepEqual(h.service.poll(identity(input())).actions, []);
			assert(!JSON.stringify(h.service.poll(identity(input()))).includes("PRIVATE"));
			assert.equal(h.service.attentionCompleted(input(), input().claimId), false);
		} finally {
			await h.service.dispose();
		}
	}
});

test("tool output, oversized, empty and incomplete model replies cannot become delivered notices", async () => {
	for (const fault of ["tools", "long", "terminal-long", "empty", "incomplete"] as const) {
		const h = harness({}, async function* () {
			if (fault === "long") yield { type: "text", delta: "x".repeat(1601) };
			if (fault === "incomplete") {
				yield { type: "text", delta: "Partial" };
				return;
			}
			yield end(
				fault === "tools"
					? [call("start_work", {})]
					: fault === "terminal-long"
						? [
								{
									type: "message",
									role: "assistant",
									content: [{ type: "output_text", text: "x".repeat(1601) }],
								},
							]
						: []
			);
		});
		try {
			h.service.attend(input());
			await terminal(h.service, input(), "error");
			assert.equal(h.service.poll(identity(input())).text, "");
			assert.deepEqual(h.service.poll(identity(input())).actions, []);
			assert.equal(h.service.attentionCompleted(input(), input().claimId), false);
		} finally {
			await h.service.dispose();
		}
	}
});

test("mixed text and unsolicited function calls never publish no-tools attention or completed history", async () => {
	for (const streamed of [true, false]) {
		const h = harness({}, async function* (request) {
			if (request.requestId !== input().requestId) {
				yield { type: "text", delta: "Real followup answer" };
				yield end();
				return;
			}
			const text = "MUST NOT BE DELIVERED";
			if (streamed) yield { type: "text", delta: text };
			yield end([
				{ type: "message", role: "assistant", content: [{ type: "output_text", text }] },
				call("start_work", {}),
			]);
		});
		try {
			h.service.attend(input());
			await terminal(h.service, input(), "error");
			const result = h.service.poll(identity(input()));
			assert.equal(result.text, "");
			assert.deepEqual(result.actions, []);
			assert(
				!result.events.some(
					(event) =>
						event.kind === "text-delta" || event.kind === "action" || event.kind === "completed"
				)
			);
			assert.equal(h.service.attentionCompleted(input(), input().claimId), false);
			assert.equal(h.service.attentionCompleted(input(), input().claimId, "spoken"), false);
			assert.deepEqual(h.requests[0]?.tools, []);
			h.service.start(user(2));
			await terminal(h.service, user(2));
			assert.deepEqual(h.requests[1]?.input, [{ role: "user", content: "What decision?" }]);
			assert(!h.requests[1]?.instructions.includes("MUST NOT BE DELIVERED"));
		} finally {
			await h.service.dispose();
		}
	}
});

test("attention has no workspace/review/hub/context effects, including cancellation", async () => {
	let accesses = 0;
	const forbidden = <T>(): T =>
		new Proxy(
			{},
			{
				get() {
					accesses++;
					throw new Error("Forbidden port");
				},
			}
		) as T;
	const h = harness({
		workspace: forbidden(),
		review: forbidden(),
		hub: forbidden(),
		getContext: async () => {
			throw new Error("Forbidden context");
		},
	});
	try {
		h.service.attend(input());
		await checkpoint(h.service, input());
		h.service.cancel({ ...identity(input()), requestId: "cancel", reason: "user" });
		await terminal(h.service, input(), "cancelled");
		assert.equal(accesses, 0);
	} finally {
		await h.service.dispose();
	}
});
