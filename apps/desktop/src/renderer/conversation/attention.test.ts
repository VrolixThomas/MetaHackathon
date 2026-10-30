import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import superjson from "superjson";
import type { AttentionClaim, AttentionSettleInput, TurnIdentity } from "../../shared/contracts";
import { createConversationApi } from "./api";
import { type AttentionSafetySnapshot, createAttentionBinding } from "./attention";
import { createConversationController } from "./controller";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const pause = (ms = 5) => new Promise((done) => setTimeout(done, ms));
async function until(condition: () => boolean) {
	const end = Date.now() + 1000;
	while (!condition()) {
		assert.ok(Date.now() < end, "Timed out");
		await pause();
	}
}
const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});
async function harness(timeout = 1000) {
	const calls: Array<{ path: string; input: Record<string, unknown> }> = [];
	const listeners = new Set<() => void>();
	let safety: AttentionSafetySnapshot = {
		enabled: true,
		focused: true,
		obscured: false,
		typing: false,
		recentInteraction: false,
		activitySequence: 0,
	};
	let ready = true;
	let beforeBegin = () => {};
	let interrupts = 0;
	let serial = 0;
	const turns: TurnIdentity[] = [];
	let poll = async (): Promise<{ claim: AttentionClaim | null }> => ({ claim: null });
	let receiptFails = false;
	const api = createConversationApi(async (request) => {
		const input = request.input
			? superjson.deserialize<Record<string, unknown>>(request.input)
			: {};
		calls.push({ path: request.path, input });
		let value: unknown;
		if (request.path === "app.config")
			value = {
				envPath: "/test/.env",
				configured: {
					meta: true,
					elevenlabs: true,
					github: false,
				},
				voiceId: "voice",
				microphone: "granted",
			};
		if (request.path === "voice.status") value = { phase: "ready", voiceId: "voice", missing: [] };
		if (request.path === "attention.poll") value = await poll();
		if (request.path === "attention.settle" || request.path === "attention.release") {
			if (receiptFails) throw new Error("Receipt transport unavailable");
			value = { status: "accepted" };
		}
		return { result: { data: superjson.serialize(value) } };
	});
	const ui = createConversationController(api, { id: () => `id-${++serial}` });
	ui.attachHandsFree({
		start: async () => {},
		stop: () => {},
		interrupt: () => {
			interrupts++;
		},
		canStartAttention: () => ready,
		startAttention: () => {
			beforeBegin();
			if (!ready) return { status: "unavailable" };
			const turn = ui.allocateIdentity();
			turns.push(turn);
			assert.equal(ui.beginAttention(turn), true);
			return { status: "started", identity: turn };
		},
	});
	await ui.configure();
	await ui.startConversation();
	const binding = createAttentionBinding(
		api,
		ui,
		{
			getSnapshot: () => safety,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		{ now: () => 1000, rpcTimeoutMs: timeout }
	);
	cleanup.push(() => {
		binding.dispose();
		ui.dispose();
	});
	const claim = (id = "claim-1"): AttentionClaim => ({
		id,
		sessionId: ui.sessionId,
		createdAt: new Date(0).toISOString(),
		expiresAt: new Date(60_000).toISOString(),
		items: [
			{
				noticeId: "notice",
				kind: "work-ready",
				jobId: "job",
				repository: "owner/repo",
				label: "Real work",
				headSha: "a".repeat(40),
				decisionId: null,
				question: null,
				changedFileCount: 2,
				applied: false,
			},
		],
	});
	return {
		api,
		ui,
		binding,
		calls,
		turns,
		turn: () => {
			const turn = turns.at(-1);
			assert.ok(turn);
			return turn;
		},
		claim,
		interrupts: () => interrupts,
		setPoll: (next: typeof poll) => {
			poll = next;
		},
		setBeforeBegin: (callback: () => void) => {
			beforeBegin = callback;
		},
		setReady: (value: boolean) => {
			ready = value;
			ui.attentionEligibilityChanged();
		},
		setReceiptFails: () => {
			receiptFails = true;
		},
		change: (patch: Partial<AttentionSafetySnapshot>) => {
			safety = { ...safety, ...patch };
			for (const listener of listeners) listener();
		},
		settles: () =>
			calls
				.filter((call) => call.path === "attention.settle")
				.map((call) => call.input as AttentionSettleInput),
		releases: () => calls.filter((call) => call.path === "attention.release"),
	};
}

test("deduplicates claims and settles only completed attention, without a synthetic user exchange", async () => {
	const h = await harness();
	h.setPoll(async () => ({ claim: h.claim() }));
	await h.binding.poll();
	assert.equal(h.turns.length, 1);
	assert.equal(h.ui.store.getState().attention?.source, "attention");
	assert.deepEqual(h.ui.store.getState().exchanges, []);
	h.ui.transcript(h.turn(), "Cannot be a user message");
	h.ui.answer(h.turn(), "The work is ready.");
	assert.equal(h.ui.store.getState().attention?.answer, "The work is ready.");
	await h.binding.poll();
	assert.deepEqual(h.settles(), []);
	h.ui.finishVoice(h.turn(), "complete");
	await until(() => h.settles().length === 1);
	await pause();
	await h.binding.poll();
	assert.equal(h.turns.length, 1);
	assert.deepEqual(h.settles(), [{ ...h.turn(), claimId: "claim-1", status: "spoken" }]);
	assert.equal(h.ui.store.getState().attention, null);
	assert.deepEqual(h.ui.store.getState().exchanges, []);
	assert.equal(h.ui.store.getState().handsFree, true);
	assert.equal(
		h.calls.some((call) => call.path === "conversation.start"),
		false
	);
});

for (const [name, patch] of Object.entries({
	optout: { enabled: false },
	blur: { focused: false },
	modal: { obscured: true },
	typing: { typing: true },
	interaction: { recentInteraction: true },
	nativeActivity: { activitySequence: 1 },
})) {
	test(`a ${name} change while claiming releases before allocation even if safety recovers`, async () => {
		const h = await harness();
		const pending = deferred<{ claim: AttentionClaim }>();
		h.setPoll(() => pending.promise);
		const first = h.binding.poll();
		await until(() => h.calls.some((call) => call.path === "attention.poll"));
		await h.binding.poll();
		h.change(patch);
		h.change({
			enabled: true,
			focused: true,
			obscured: false,
			typing: false,
			recentInteraction: false,
		});
		pending.resolve({ claim: h.claim() });
		await first;
		assert.equal(h.calls.filter((call) => call.path === "attention.poll").length, 1);
		assert.deepEqual(h.turns, []);
		assert.equal(h.releases().length, 1);
		assert.deepEqual(h.settles(), []);
	});
}

for (const [name, patch] of Object.entries({
	optout: { enabled: false },
	blur: { focused: false },
	modal: { obscured: true },
	typing: { typing: true },
	interaction: { recentInteraction: true },
	nativeActivity: { activitySequence: 1 },
})) {
	test(`${name} during attention interrupts only that update and preserves the microphone`, async () => {
		const h = await harness();
		h.setPoll(async () => ({ claim: h.claim() }));
		await h.binding.poll();
		h.change(patch);
		await until(() => h.settles().length === 1);
		assert.equal(h.settles()[0]?.status, "interrupted");
		assert.equal(h.interrupts(), 1);
		assert.equal(h.ui.store.getState().handsFree, true);
		const user = h.ui.allocateIdentity();
		assert.equal(h.ui.beginVoice(user), true);
		h.ui.transcript(user, "My actual question");
		h.ui.finishVoice(h.turn(), "complete");
		h.change({ activitySequence: 2 });
		assert.deepEqual(h.ui.store.getState().active, user);
		assert.equal(h.ui.store.getState().exchanges[0]?.question, "My actual question");
		assert.equal(h.settles().length, 1);
	});
}

test("a user turn or pending VAD onset while claiming invalidates the quiet window", async () => {
	for (const mode of ["turn", "vad"]) {
		const h = await harness();
		const pending = deferred<{ claim: AttentionClaim }>();
		h.setPoll(() => pending.promise);
		const work = h.binding.poll();
		await until(() => h.calls.some((call) => call.path === "attention.poll"));
		if (mode === "turn") {
			const turn = h.ui.allocateIdentity();
			h.ui.beginVoice(turn);
			h.ui.finishVoice(turn, "complete");
		} else {
			h.setReady(false);
			h.setReady(true);
		}
		pending.resolve({ claim: h.claim() });
		await work;
		assert.deepEqual(h.turns, []);
		assert.equal(h.releases().length, 1);
	}
});

test("expired and foreign-session claims are released without allocating a turn", async () => {
	for (const patch of [
		{ expiresAt: new Date(1000).toISOString() },
		{ sessionId: "other-session" },
	]) {
		const h = await harness();
		h.setPoll(async () => ({ claim: { ...h.claim(), ...patch } }));
		await h.binding.poll();
		assert.deepEqual(h.turns, []);
		assert.equal(h.releases().length, 1);
	}
});

test("disabled and pending speech presence cannot be promoted by a returned claim", async () => {
	for (const mode of ["disabled", "vad"]) {
		const h = await harness();
		if (mode === "disabled") h.change({ enabled: false });
		else h.setReady(false);
		h.setPoll(async () => ({ claim: h.claim() }));
		await h.binding.poll();
		assert.equal(
			h.calls.find((call) => call.path === "attention.poll")?.input["state"],
			mode === "disabled" ? "disabled" : "user-speaking"
		);
		assert.deepEqual(h.turns, []);
		assert.equal(h.releases().length, 1);
	}
});

for (const mode of ["dispose", "timeout"]) {
	test(`a late claim after ${mode} is released exactly once`, async () => {
		const h = await harness(20);
		const pending = deferred<{ claim: AttentionClaim }>();
		h.setPoll(() => pending.promise);
		const work = h.binding.poll();
		await until(() => h.calls.some((call) => call.path === "attention.poll"));
		if (mode === "dispose") h.binding.dispose();
		await work;
		pending.resolve({ claim: h.claim() });
		await until(() => h.releases().length === 1);
		assert.deepEqual(h.turns, []);
	});
}

test("reentrant activity during allocation settles interrupted and cannot leave an active update", async () => {
	const h = await harness();
	h.setPoll(async () => ({ claim: h.claim() }));
	const unsubscribe = h.ui.store.subscribe((state) => {
		if (state.attention) h.change({ activitySequence: 1 });
	});
	await h.binding.poll();
	unsubscribe();
	await until(() => h.settles().length === 1);
	assert.equal(h.settles()[0]?.status, "interrupted");
	assert.equal(h.ui.store.getState().active, null);
	assert.equal(h.ui.store.getState().handsFree, true);
});

test("failed attention is not called spoken and receipt transport failure cannot replay that claim", async () => {
	const h = await harness();
	h.setPoll(async () => ({ claim: h.claim() }));
	await h.binding.poll();
	h.setReceiptFails();
	h.ui.finishVoice(h.turn(), "error", "Model failed", true);
	await until(() => h.settles().length === 1);
	await pause();
	await h.binding.poll();
	assert.equal(h.settles()[0]?.status, "failed");
	assert.equal(h.turns.length, 1);
	assert.equal(h.ui.store.getState().handsFree, true);
});

test("activity before the attention start hook is rechecked after synchronous media allocation", async () => {
	const h = await harness();
	h.setPoll(async () => ({ claim: h.claim() }));
	h.setBeforeBegin(() => {
		h.change({ focused: false });
		h.change({ focused: true });
	});
	await h.binding.poll();
	await until(() => h.settles().length === 1);
	assert.equal(h.settles()[0]?.status, "interrupted");
	assert.equal(h.ui.store.getState().active, null);
	assert.equal(h.ui.store.getState().handsFree, true);
});

test("a final hands-free veto releases the claim without allocating or settling a turn", async () => {
	const h = await harness();
	h.setPoll(async () => ({ claim: h.claim() }));
	h.setBeforeBegin(() => h.setReady(false));
	await h.binding.poll();
	assert.equal(h.releases().length, 1);
	assert.deepEqual(h.turns, []);
	assert.deepEqual(h.settles(), []);
});

test("disposing the binding during playback sends interrupted and keeps the explicit microphone session", async () => {
	const h = await harness();
	h.setPoll(async () => ({ claim: h.claim() }));
	await h.binding.poll();
	h.binding.dispose();
	await until(() => h.settles().length === 1);
	assert.equal(h.settles()[0]?.status, "interrupted");
	assert.equal(h.ui.store.getState().handsFree, true);
	assert.equal(h.ui.store.getState().active, null);
});
