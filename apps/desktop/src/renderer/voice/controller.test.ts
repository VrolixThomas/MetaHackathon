import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { VoiceDiagnosticError } from "../../main/voice/diagnostics";
import type { SpeakInput, VoiceEvent, VoicePollResult } from "../../main/voice/protocol";
import { AgentTurnInputSchema, ConversationTurnInputSchema } from "../../shared/contracts";
import type {
	AgentAction,
	AgentEvent,
	AgentTurnInput,
	CancelTurnInput,
	ConversationTurnInput,
	PollTurn,
	PollTurnResult,
	ScreenContext,
	TurnIdentity,
} from "../../shared/contracts";
import { createVoiceController } from "./controller";
import type {
	LatencyObservation,
	MediaFactory,
	VoiceController,
	VoiceControllerOptions,
	VoiceTurnEnd,
} from "./types";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
	const end = Date.now() + 2000;
	while (!predicate()) {
		assert.ok(Date.now() < end, "condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 25));
const controllers: VoiceController[] = [];
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
});

function harness(overrides: Partial<VoiceControllerOptions> = {}) {
	let serial = 0;
	let clock = 100;
	let screen: ScreenContext = { prId: "pr-1", sequence: 2, panel: "diff", focusedLocation: null };
	const voiceEvents: VoiceEvent[] = [];
	const starts: AgentTurnInput[] = [];
	const cancels = { voice: [] as TurnIdentity[], agent: [] as CancelTurnInput[] };
	const speaks: SpeakInput[] = [];
	const releases: TurnIdentity[] = [];
	const events: AgentEvent[] = [];
	const actions: AgentAction[] = [];
	const latencies: LatencyObservation[] = [];
	const answers: string[] = [];
	const errors: Error[] = [];
	const media: Array<{ observer: Parameters<MediaFactory>[0]; closed: boolean; stopped: boolean }> =
		[];
	let poll: (input: PollTurn) => Promise<PollTurnResult> = async (input) => ({
		...identity(input),
		status: "running",
		sequence: 0,
		events: [],
		text: "",
		actions: [],
	});
	const options: VoiceControllerOptions = {
		acknowledgementText: "Acknowledged.",
		now: () => clock,
		id: () => `test-${++serial}`,
		pollIntervalMs: 10,
		getScreenContext: () => screen,
		onEvent: (event) => {
			events.push(event);
		},
		onAction: (action) => {
			actions.push(action);
		},
		onLatency: (value) => {
			latencies.push(value);
		},
		onAnswer: (text) => {
			answers.push(text);
		},
		onError: (error) => {
			errors.push(error);
		},
		voice: {
			offer: async () => ({ type: "answer", sdp: "answer" }),
			release: async (input) => {
				releases.push(input);
			},
			speak: async (input) => {
				speaks.push(input);
			},
			cancel: async (input) => {
				cancels.voice.push(input);
			},
			poll: async (input) => ({
				events: voiceEvents.filter((event) => event.sequence > input.afterSequence),
			}),
		},
		agent: {
			start: async (input) => {
				starts.push(AgentTurnInputSchema.parse(input));
				return { ...identity(input), status: "running" };
			},
			poll: (input) => poll(input),
			cancel: async (input) => {
				cancels.agent.push(input);
				return { ...identity(input), requestId: input.requestId, status: "cancelled" };
			},
		},
		media: (observer) => {
			const handle = { observer, closed: false, stopped: false };
			media.push(handle);
			return {
				connect: async (offer) => {
					await offer({ type: "offer", sdp: "offer" });
				},
				stopCapture: () => {
					handle.stopped = true;
				},
				drain: async () => {},
				close: () => {
					handle.closed = true;
					handle.stopped = true;
				},
			};
		},
		...overrides,
	};
	const controller = createVoiceController(options);
	controllers.push(controller);
	const current = (): TurnIdentity => {
		const snapshot = controller.snapshot;
		assert.ok(snapshot.turnId);
		return {
			sessionId: snapshot.sessionId,
			turnId: snapshot.turnId,
			generation: snapshot.generation,
		};
	};
	const emit = (
		value:
			| Omit<Extract<VoiceEvent, { kind: "transcript" }>, keyof TurnIdentity | "sequence">
			| { kind: "speech-ended" | "speech-started"; speechId: string }
	) => {
		voiceEvents.push({ ...current(), sequence: voiceEvents.length + 1, ...value });
	};
	return {
		controller,
		options,
		starts,
		speaks,
		releases,
		cancels,
		events,
		actions,
		latencies,
		answers,
		errors,
		media,
		voiceEvents,
		current,
		emit,
		setPoll: (value: typeof poll) => {
			poll = value;
		},
		setScreen: (value: ScreenContext) => {
			screen = value;
		},
		setNow: (value: number) => {
			clock = value;
		},
		async capture() {
			controller.beginCapture();
			await wait();
			controller.endCapture();
		},
		async final(text = "Explain the selected change") {
			emit({ kind: "transcript", text, final: true });
			await until(() => starts.length > 0 || speaks.length > 0);
		},
	};
}
function identity(value: TurnIdentity): TurnIdentity {
	return { sessionId: value.sessionId, turnId: value.turnId, generation: value.generation };
}

test("V1 conversation speaks one reply without a PR or screen, optionally attaches a real PR", async () => {
	const contexts: Pick<ConversationTurnInput, "prId" | "screen" | "workspace">[] = [
		{},
		{ prId: "selected-pr" },
		{
			workspace: {
				sequence: 3,
				canvases: [{ id: "review", kind: "review", title: "Review", revision: 1 }],
				primaryId: "review",
				secondaryId: null,
				review: { sequence: 0, mode: "conversation", prId: null },
				codeView: "diff",
				browser: null,
			},
		},
		{
			prId: "selected-pr",
			screen: {
				sequence: 7,
				mode: "review",
				prId: "selected-pr",
				reviewId: "prepared-review",
				path: "src/cart.ts",
				baseSha: "a".repeat(40),
				headSha: "b".repeat(40),
			},
		},
	];
	for (const context of contexts) {
		const starts: ConversationTurnInput[] = [];
		const h = harness({
			getConversationContext: () => context,
			getScreenContext: undefined,
			acknowledgementText: undefined,
		});
		h.options.agent.start = async (input) => {
			starts.push(ConversationTurnInputSchema.parse(input));
			return { ...identity(input), status: "running" };
		};
		h.setPoll(async (input) => ({
			...identity(input),
			status: "completed",
			sequence: 2,
			text: "Hello there.",
			actions: [],
			events: [
				{ ...identity(input), sequence: 1, kind: "text-delta", delta: "Hello there." },
				{ ...identity(input), sequence: 2, kind: "completed" },
			],
		}));
		await h.capture();
		await h.final("Hello");
		h.emit({ kind: "transcript", text: "duplicate", final: true });
		await until(() => h.answers.includes("Hello there."));
		assert.equal(starts.length, 1);
		assert.ok(starts[0]);
		assert.deepEqual(identity(starts[0]), h.current());
		assert.equal("screenContext" in starts[0], false);
		assert.equal("prId" in starts[0], "prId" in context);
		assert.equal(starts[0].prId, context.prId);
		assert.equal("screen" in starts[0], "screen" in context);
		assert.deepEqual(starts[0].screen, context.screen);
		assert.equal("workspace" in starts[0], "workspace" in context);
		assert.deepEqual(starts[0].workspace, context.workspace);
		h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
		await until(() => h.controller.getPhase() === "idle");
		assert.deepEqual(
			h.speaks.map((speech) => speech.text),
			["Hello there."]
		);
		assert.equal(h.cancels.voice.length, 1);
		assert.equal(h.cancels.agent.length, 1);
	}
});

function reviewNavigation(turn: TurnIdentity, requestId: string): AgentAction {
	return {
		...identity(turn),
		requestId,
		screenSequence: 7,
		kind: "review-navigation",
		navigation: {
			reviewId: "prepared-review",
			prId: "selected-pr",
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
			path: "src/cart.ts",
			paused: false,
		},
	};
}

function narrationCheckpoint(
	turn: TurnIdentity,
	requestId: string,
	throughTextLength: number
): Extract<AgentAction, { kind: "narration-checkpoint" }> {
	return {
		...identity(turn),
		requestId,
		screenSequence: 7,
		kind: "narration-checkpoint",
		throughTextLength,
	};
}

test("narration waits for held speech RPC, every speech-ended and PCM drain before its receipt", async () => {
	const speech = deferred<void>();
	const drains = [deferred<void>(), deferred<void>()];
	let draining = 0;
	let closed = false;
	const spoken: AgentAction[] = [];
	const ui: AgentAction[] = [];
	const ends: VoiceTurnEnd[] = [];
	const text = "First sentence. Pending segment";
	const h = harness({
		getConversationContext: () => ({}),
		acknowledgementText: undefined,
		completionText: "Extra completion must not play.",
		onNarrationCheckpoint: (action, signal) => {
			assert.equal(signal.aborted, false);
			assert.equal(closed, false);
			assert.equal(draining, 2);
			spoken.push(action);
		},
		onConversationAction: (action) => {
			ui.push(action);
		},
		onTurnEnd: (_identity, result) => {
			ends.push(result);
		},
		media: () => ({
			connect: async (offer) => {
				await offer({ type: "offer", sdp: "offer" });
			},
			stopCapture: () => {},
			drain: () => drains[draining++]?.promise ?? Promise.reject(new Error("Unexpected drain")),
			close: () => {
				closed = true;
			},
		}),
	});
	h.options.agent.start = async (input) => ({ ...identity(input), status: "running" });
	const speak = h.options.voice.speak;
	h.options.voice.speak = async (input, signal) => {
		await speak(input, signal);
		if (h.speaks.length === 1) await speech.promise;
	};
	h.setPoll(async (input) => {
		const checkpoint = narrationCheckpoint(input, "spoken-prefix", text.length);
		const next = reviewNavigation(input, "next-file");
		return {
			...identity(input),
			status: "completed",
			sequence: 4,
			text,
			events: [
				{ ...identity(input), sequence: 1, kind: "text-delta", delta: text },
				{ ...identity(input), sequence: 2, kind: "action", action: checkpoint },
				{ ...identity(input), sequence: 3, kind: "action", action: next },
				{ ...identity(input), sequence: 4, kind: "completed" },
			],
			actions: [checkpoint, next],
		};
	});
	await h.capture();
	h.emit({ kind: "transcript", text: "Walk me through it", final: true });
	await until(() => h.speaks.length === 1);
	h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
	await wait();
	assert.equal(draining, 0, "speech-ended cannot outrun an unfinished speak RPC");
	assert.equal(spoken.length, 0);
	speech.resolve();
	await until(() => draining === 1);
	assert.equal(ui.length, 0);
	assert.equal(spoken.length, 0);
	drains[0]?.resolve();
	await until(() => h.speaks.length === 2);
	assert.deepEqual(ends, []);
	assert.equal(closed, false);
	assert.equal(spoken.length, 0);
	h.emit({ kind: "speech-ended", speechId: h.speaks[1]?.speechId ?? "missing" });
	await until(() => draining === 2);
	assert.equal(spoken.length, 0);
	assert.equal(ui.length, 0);
	drains[1]?.resolve();
	await until(() => h.controller.getPhase() === "idle");
	assert.deepEqual(
		spoken.map((action) => action.requestId),
		["spoken-prefix"]
	);
	assert.deepEqual(
		ui.map((action) => action.requestId),
		["next-file"]
	);
	assert.deepEqual(
		h.speaks.map((speech) => speech.text),
		["First sentence.", "Pending segment"]
	);
	assert.deepEqual(ends, [{ status: "completed" }]);
	assert.deepEqual(h.errors, []);
});

test("repeated polls and event/snapshot checkpoints deduplicate while the next segment stays in the same turn", async () => {
	const checkpoints: AgentAction[] = [];
	const receipt = deferred<void>();
	const prefix = "First segment without punctuation";
	const suffix = " Second segment.";
	let polls = 0;
	let proceed = false;
	const h = harness({
		getConversationContext: () => ({}),
		acknowledgementText: undefined,
		completionText: "Extra completion must not play.",
		onNarrationCheckpoint: (action) => {
			checkpoints.push(action);
			return receipt.promise;
		},
		onConversationAction: () => {
			throw new Error("Checkpoint cannot reach UI action hook");
		},
	});
	h.options.agent.start = async (input) => ({ ...identity(input), status: "running" });
	h.setPoll(async (input) => {
		polls++;
		const first = narrationCheckpoint(input, "first-segment", prefix.length);
		const second = narrationCheckpoint(input, "second-segment", prefix.length + suffix.length);
		const events: AgentEvent[] = [
			{ ...identity(input), sequence: 1, kind: "text-delta", delta: prefix },
			{ ...identity(input), sequence: 2, kind: "action", action: first },
		];
		if (proceed)
			events.push(
				{ ...identity(input), sequence: 3, kind: "text-delta", delta: suffix },
				{ ...identity(input), sequence: 4, kind: "action", action: second },
				{ ...identity(input), sequence: 5, kind: "completed" }
			);
		return {
			...identity(input),
			status: proceed ? "completed" : "running",
			sequence: proceed ? 5 : 2,
			text: prefix + (proceed ? suffix : ""),
			events,
			actions: proceed ? [first, second] : [first],
		};
	});
	await h.capture();
	h.emit({ kind: "transcript", text: "Walk through the related files", final: true });
	await until(() => h.speaks.length === 1);
	const turn = h.current();
	h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
	await until(() => checkpoints.length === 1);
	await wait();
	assert.equal(polls, 1, "Receipt acknowledgement remains ordered before later polls");
	assert.equal(h.media[0]?.closed, false);
	receipt.resolve();
	await until(() => polls >= 3);
	assert.equal(checkpoints.length, 1);
	assert.equal(h.speaks.length, 1);
	assert.deepEqual(h.controller.getIdentity(), turn);
	proceed = true;
	await until(() => h.speaks.length === 2);
	assert.equal(checkpoints.length, 1);
	h.emit({ kind: "speech-ended", speechId: h.speaks[1]?.speechId ?? "missing" });
	await until(() => h.controller.getPhase() === "idle");
	assert.deepEqual(
		checkpoints.map((action) => action.requestId),
		["first-segment", "second-segment"]
	);
	assert.deepEqual(
		h.speaks.map((speech) => speech.text),
		[prefix, suffix.trim()]
	);
	assert.ok(
		h.speaks.every(
			(speech) => speech.turnId === turn.turnId && speech.generation === turn.generation
		)
	);
	assert.deepEqual(h.errors, []);
});

for (const recovery of ["gap", "empty"] as const) {
	test(`compacted ${recovery} snapshot respects checkpoint prefixes before applying later navigation`, async () => {
		const checkpoints: AgentAction[] = [];
		const ui: AgentAction[] = [];
		const prefix = "Recovered first file";
		const suffix = " Recovered second file";
		const h = harness({
			getConversationContext: () => ({}),
			acknowledgementText: undefined,
			onNarrationCheckpoint: (action) => {
				checkpoints.push(action);
			},
			onConversationAction: (action) => {
				ui.push(action);
			},
		});
		h.options.agent.start = async (input) => ({ ...identity(input), status: "running" });
		h.setPoll(async (input) => ({
			...identity(input),
			status: "completed",
			sequence: 50,
			text: prefix + suffix,
			events: recovery === "gap" ? [{ ...identity(input), sequence: 50, kind: "completed" }] : [],
			actions: [
				reviewNavigation(input, "first-file"),
				narrationCheckpoint(input, "first-prefix", prefix.length),
				reviewNavigation(input, "second-file"),
				narrationCheckpoint(input, "second-prefix", prefix.length + suffix.length),
			],
		}));
		await h.capture();
		h.emit({ kind: "transcript", text: "Continue", final: true });
		await until(() => h.speaks.length === 1);
		assert.deepEqual(h.answers, [prefix]);
		assert.deepEqual(
			ui.map((action) => action.requestId),
			["first-file"]
		);
		assert.equal(checkpoints.length, 0);
		h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
		await until(() => h.speaks.length === 2);
		assert.deepEqual(
			ui.map((action) => action.requestId),
			["first-file", "second-file"]
		);
		assert.deepEqual(
			checkpoints.map((action) => action.requestId),
			["first-prefix"]
		);
		h.emit({ kind: "speech-ended", speechId: h.speaks[1]?.speechId ?? "missing" });
		await until(() => h.controller.getPhase() === "idle");
		assert.deepEqual(
			checkpoints.map((action) => action.requestId),
			["first-prefix", "second-prefix"]
		);
		assert.deepEqual(
			h.speaks.map((speech) => speech.text),
			[prefix, suffix.trim()]
		);
		assert.deepEqual(h.errors, []);
	});
}

for (const stage of ["rpc", "speech-ended", "drain", "receipt"] as const) {
	test(`cancelling a checkpoint during ${stage} drops its late receipt and old turn effects`, async () => {
		const speech = deferred<void>();
		const drain = deferred<void>();
		const receipt = deferred<void>();
		let draining = false;
		let checkpointCalls = 0;
		let receipts = 0;
		let ui = 0;
		let speechSignal: AbortSignal | undefined;
		let receiptSignal: AbortSignal | undefined;
		const text = "Pending narration";
		const h = harness({
			getConversationContext: () => ({}),
			acknowledgementText: undefined,
			onNarrationCheckpoint: async (_action, signal) => {
				checkpointCalls++;
				receiptSignal = signal;
				await receipt.promise;
				if (!signal.aborted) receipts++;
			},
			onConversationAction: () => {
				ui++;
			},
			media: () => ({
				connect: async (offer) => {
					await offer({ type: "offer", sdp: "offer" });
				},
				stopCapture: () => {},
				drain: () => {
					draining = true;
					return drain.promise;
				},
				close: () => {},
			}),
		});
		h.options.agent.start = async (input) => ({ ...identity(input), status: "running" });
		const speak = h.options.voice.speak;
		h.options.voice.speak = async (input, signal) => {
			speechSignal = signal;
			await speak(input, signal);
			if (stage === "rpc") await speech.promise;
		};
		h.setPoll(async (input) => ({
			...identity(input),
			status: "running",
			sequence: 3,
			text,
			events: [
				{ ...identity(input), sequence: 1, kind: "text-delta", delta: text },
				{
					...identity(input),
					sequence: 2,
					kind: "action",
					action: narrationCheckpoint(input, "pending", text.length),
				},
				{
					...identity(input),
					sequence: 3,
					kind: "action",
					action: reviewNavigation(input, "late-next-file"),
				},
			],
			actions: [],
		}));
		await h.capture();
		h.emit({ kind: "transcript", text: "Explain", final: true });
		await until(() => h.speaks.length === 1);
		const old = h.current();
		if (stage === "drain" || stage === "receipt") {
			h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
			await until(() => draining);
		}
		if (stage === "receipt") {
			drain.resolve();
			await until(() => checkpointCalls === 1);
		}
		h.controller.interrupt("push-to-talk");
		assert.equal(speechSignal?.aborted, true);
		if (receiptSignal) assert.equal(receiptSignal.aborted, true);
		assert.ok(h.cancels.voice.some((value) => value.turnId === old.turnId));
		assert.ok(h.cancels.agent.some((value) => value.turnId === old.turnId));
		h.controller.beginCapture();
		const next = h.current();
		assert.ok(next.generation > old.generation);
		speech.resolve();
		drain.resolve();
		receipt.resolve();
		h.voiceEvents.push({
			...old,
			sequence: 99,
			kind: "speech-ended",
			speechId: h.speaks[0]?.speechId ?? "missing",
		});
		await until(() => h.controller.getPhase() === "listening");
		await wait();
		assert.equal(checkpointCalls, stage === "receipt" ? 1 : 0);
		assert.equal(receipts, 0);
		assert.equal(ui, 0);
		assert.deepEqual(h.controller.getIdentity(), next);
		assert.equal(h.speaks.length, 1);
		assert.deepEqual(h.errors, []);
	});
}

for (const mismatch of ["short", "long", "changed-prefix"] as const) {
	test(`a ${mismatch} checkpoint prefix cannot produce a spoken receipt or flush pending text`, async () => {
		let checkpoints = 0;
		const text = "Pending narration";
		const ends: VoiceTurnEnd[] = [];
		const h = harness({
			getConversationContext: () => ({}),
			acknowledgementText: undefined,
			onNarrationCheckpoint: () => {
				checkpoints++;
			},
			onTurnEnd: (_identity, result) => {
				ends.push(result);
			},
		});
		h.options.agent.start = async (input) => ({ ...identity(input), status: "running" });
		h.setPoll(async (input) => ({
			...identity(input),
			status: "running",
			sequence: 2,
			text: mismatch === "changed-prefix" ? "Different narration" : text,
			events: [
				{ ...identity(input), sequence: 1, kind: "text-delta", delta: text },
				{
					...identity(input),
					sequence: 2,
					kind: "action",
					action: narrationCheckpoint(
						input,
						"mismatch",
						text.length + (mismatch === "short" ? -1 : mismatch === "long" ? 1 : 0)
					),
				},
			],
			actions: [],
		}));
		await h.capture();
		h.emit({ kind: "transcript", text: "Explain", final: true });
		await until(() => h.controller.getPhase() === "error");
		assert.equal(checkpoints, 0);
		assert.deepEqual(h.speaks, []);
		assert.equal(ends[0]?.status, "failed");
		if (ends[0]?.status === "failed") {
			assert.equal(ends[0].origin, "agent");
			assert.equal(ends[0].recoverable, true);
		}
		assert.equal(h.cancels.voice.length, 1);
		assert.equal(h.cancels.agent.length, 1);
	});
}

for (const stage of ["speech-ended", "drain", "receipt"] as const) {
	test(`checkpoint ${stage} waiting is bounded and prevents late acknowledgement`, async () => {
		const drain = deferred<void>();
		const receipt = deferred<void>();
		let checkpointCalls = 0;
		let receipts = 0;
		let signal: AbortSignal | undefined;
		const text = "Pending narration";
		const h = harness({
			getConversationContext: () => ({}),
			acknowledgementText: undefined,
			speechTimeoutMs: 100,
			rpcTimeoutMs: 100,
			onNarrationCheckpoint: async (_action, abort) => {
				checkpointCalls++;
				signal = abort;
				await receipt.promise;
				if (!abort.aborted) receipts++;
			},
			media: () => ({
				connect: async (offer) => {
					await offer({ type: "offer", sdp: "offer" });
				},
				stopCapture: () => {},
				drain: () => (stage === "drain" ? drain.promise : Promise.resolve()),
				close: () => {},
			}),
		});
		h.options.agent.start = async (input) => ({ ...identity(input), status: "running" });
		h.setPoll(async (input) => ({
			...identity(input),
			status: "running",
			sequence: 2,
			text,
			events: [
				{ ...identity(input), sequence: 1, kind: "text-delta", delta: text },
				{
					...identity(input),
					sequence: 2,
					kind: "action",
					action: narrationCheckpoint(input, "stalled", text.length),
				},
			],
			actions: [],
		}));
		await h.capture();
		h.emit({ kind: "transcript", text: "Explain", final: true });
		await until(() => h.speaks.length === 1);
		if (stage !== "speech-ended")
			h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
		await until(() => h.controller.getPhase() === "error");
		assert.equal(checkpointCalls, stage === "receipt" ? 1 : 0);
		if (signal) assert.equal(signal.aborted, true);
		drain.resolve();
		receipt.resolve();
		await wait();
		assert.equal(receipts, 0);
		assert.equal(h.cancels.voice.length, 1);
		assert.equal(h.cancels.agent.length, 1);
	});
}

test("conversation event and snapshot actions flow once and wait for the UI receipt before reply", async () => {
	const receipt = deferred<void>();
	const delivered: AgentAction[] = [];
	const h = harness({
		acknowledgementText: undefined,
		getConversationContext: () => ({ prId: "selected-pr" }),
		getScreenContext: () => {
			throw new Error("Conversation must not read a legacy screen");
		},
		onConversationAction: (action, signal) => {
			assert.equal(signal.aborted, false);
			delivered.push(action);
			return receipt.promise;
		},
	});
	h.options.agent.start = async (input) => ({ ...identity(input), status: "running" });
	h.setPoll(async (input) => {
		const eventAction = reviewNavigation(input, "event-and-snapshot");
		return {
			...identity(input),
			status: "completed",
			sequence: 3,
			text: "Here is the change.",
			events: [
				{ ...identity(input), sequence: 1, kind: "action", action: eventAction },
				{ ...identity(input), sequence: 2, kind: "text-delta", delta: "Here is the change." },
				{ ...identity(input), sequence: 3, kind: "completed" },
			],
			actions: [eventAction, reviewNavigation(input, "snapshot-only")],
		};
	});
	await h.capture();
	h.emit({ kind: "transcript", text: "Next file", final: true });
	await until(() => delivered.length === 1);
	assert.deepEqual(h.answers, []);
	assert.equal(h.speaks.length, 0, "No filler or answer before the UI receipt settles");
	receipt.resolve();
	await until(() => delivered.length === 2 && h.speaks.length === 1);
	assert.deepEqual(
		delivered.map((action) => action.requestId),
		["event-and-snapshot", "snapshot-only"]
	);
	assert.ok(delivered.every((action) => action.turnId === h.current().turnId));
	assert.deepEqual(h.actions, [], "Legacy review callback is not used");
	h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
	await until(() => h.controller.getPhase() === "idle");
	assert.equal(delivered.length, 2);
});

test("conversation action cancellation aborts the receipt and drops the remaining old turn effects", async () => {
	const receipt = deferred<void>();
	const delivered: AgentAction[] = [];
	let signal: AbortSignal | undefined;
	const h = harness({
		getConversationContext: () => ({}),
		acknowledgementText: undefined,
		onConversationAction: (action, abort) => {
			delivered.push(action);
			signal = abort;
			return receipt.promise;
		},
	});
	h.options.agent.start = async (input) => ({ ...identity(input), status: "running" });
	h.setPoll(async (input) => ({
		...identity(input),
		status: "running",
		sequence: 0,
		text: "",
		events: [],
		actions: [reviewNavigation(input, "first"), reviewNavigation(input, "late")],
	}));
	await h.capture();
	h.emit({ kind: "transcript", text: "Next", final: true });
	await until(() => delivered.length === 1);
	const old = h.current();
	h.controller.interrupt("navigation");
	assert.equal(signal?.aborted, true);
	assert.equal(h.media[0]?.closed, true);
	assert.equal(h.cancels.voice.length, 1);
	assert.equal(h.cancels.agent.length, 1);
	h.controller.beginCapture();
	const next = h.current();
	assert.equal(next.sessionId, old.sessionId);
	assert.ok(next.generation > old.generation);
	receipt.resolve();
	await until(() => h.controller.getPhase() === "listening");
	await wait();
	assert.deepEqual(h.controller.getIdentity(), next);
	assert.deepEqual(
		delivered.map((action) => action.requestId),
		["first"]
	);
	assert.deepEqual(h.speaks, []);
	assert.deepEqual(h.errors, []);
});

test("foreign conversation action identities never reach the UI callback", async () => {
	for (const foreign of [{ sessionId: "foreign" }, { turnId: "foreign" }, { generation: 999 }]) {
		const delivered: AgentAction[] = [];
		const h = harness({
			getConversationContext: () => ({}),
			acknowledgementText: undefined,
			onConversationAction: (action) => {
				delivered.push(action);
			},
		});
		h.options.agent.start = async (input) => ({ ...identity(input), status: "running" });
		h.setPoll(async (input) => {
			const other = { ...identity(input), ...foreign };
			return {
				...other,
				status: "running",
				sequence: 0,
				text: "",
				events: [],
				actions: [reviewNavigation(other, "foreign")],
			};
		});
		await h.capture();
		h.emit({ kind: "transcript", text: "Next", final: true });
		await until(() => h.controller.getPhase() === "error");
		assert.deepEqual(delivered, []);
		assert.deepEqual(h.speaks, []);
	}
});

test("a stalled conversation action receipt remains bounded and cancels both services", async () => {
	const h = harness({
		getConversationContext: () => ({}),
		acknowledgementText: undefined,
		rpcTimeoutMs: 100,
		onConversationAction: () => new Promise(() => {}),
	});
	h.options.agent.start = async (input) => ({ ...identity(input), status: "running" });
	h.setPoll(async (input) => ({
		...identity(input),
		status: "running",
		sequence: 0,
		text: "",
		events: [],
		actions: [reviewNavigation(input, "stalled")],
	}));
	await h.capture();
	h.emit({ kind: "transcript", text: "Next", final: true });
	await until(() => h.controller.getPhase() === "error");
	assert.equal(h.cancels.voice.length, 1);
	assert.equal(h.cancels.agent.length, 1);
	assert.equal(h.media[0]?.closed, true);
});

test("V1 preserves the shared identity when a late start is cancelled without reading a screen", async () => {
	const pending = deferred<TurnIdentity & { status: "running" }>();
	const shared = { sessionId: "conversation", turnId: "spoken", generation: 8 };
	const h = harness({
		sessionId: shared.sessionId,
		allocateIdentity: () => shared,
		getConversationContext: () => ({}),
		getScreenContext: () => {
			throw new Error("V1 must not read a screen");
		},
	});
	h.options.agent.start = () => pending.promise;
	await h.capture();
	await h.final();
	h.controller.interrupt();
	pending.resolve({ ...shared, status: "running" });
	await until(() => h.cancels.agent.length === 2);
	assert.ok(h.cancels.agent.every((input) => input.generation === shared.generation));
	assert.equal(h.media[0]?.closed, true);
	assert.equal(h.controller.getPhase(), "cancelled");
	assert.deepEqual(h.actions, []);
});

test("keyup during permission/setup cancels synchronously and cannot resume late", async () => {
	const setup = deferred<void>();
	let closed = false;
	const h = harness({
		media: () => ({
			connect: () => setup.promise,
			close: () => {
				closed = true;
			},
			stopCapture: () => {},
			drain: async () => {},
		}),
	});
	assert.equal(h.controller.beginCapture(), undefined);
	h.controller.endCapture();
	assert.equal(closed, true);
	assert.equal(h.controller.getPhase(), "cancelled");
	assert.equal(h.cancels.voice.length, 1);
	assert.equal(h.cancels.agent.length, 1);
	setup.resolve();
	await wait();
	assert.equal(h.controller.getPhase(), "cancelled");
	assert.equal(h.releases.length, 0);
	assert.equal(h.starts.length, 0);
});

test("human media setup can outlast the RPC deadline while the offer remains bounded", async () => {
	const ready = deferred<void>();
	const h = harness({
		rpcTimeoutMs: 100,
		mediaSetupTimeoutMs: 1000,
		media: () => ({
			connect: async (offer) => {
				await ready.promise;
				await offer({ type: "offer", sdp: "offer" });
			},
			close() {},
			stopCapture() {},
			drain: async () => {},
		}),
	});
	h.controller.beginCapture();
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(h.controller.connecting, true);
	assert.deepEqual(h.errors, []);
	h.options.voice.offer = () => new Promise(() => {});
	ready.resolve();
	await until(() => h.controller.getPhase() === "error");
	assert.equal(h.cancels.voice.length, 1);
	assert.equal(h.cancels.agent.length, 1);
});

test("the first failure survives synchronous media teardown and late cancellation errors", async () => {
	const first = new Error("Primary microphone failure");
	const h = harness({
		media: () => ({
			connect: async () => {
				throw first;
			},
			close: () => {
				throw new Error("Secondary close failure");
			},
			stopCapture() {},
			drain: async () => {},
		}),
	});
	h.options.voice.cancel = async () => {
		throw new Error("Secondary cancel failure");
	};
	h.options.agent.cancel = async () => {
		throw new Error("Secondary agent cancel failure");
	};
	h.controller.beginCapture();
	await until(() => h.controller.getPhase() === "error");
	await wait();
	assert.equal(h.controller.getSnapshot().error, first.message);
	assert.deepEqual(h.errors, [first]);
});

test("structured provider failure uses canonical copy rather than the polled message", async () => {
	const h = harness();
	await h.capture();
	h.voiceEvents.push({
		...h.current(),
		sequence: 1,
		kind: "error",
		message: "private-provider-body",
		diagnostic: { stage: "meta", code: "auth", httpStatus: 401 },
	});
	await until(() => h.controller.getPhase() === "error");
	assert.ok(h.errors[0] instanceof VoiceDiagnosticError);
	assert.equal(h.controller.snapshot.error?.includes("private-provider-body"), false);
	assert.match(h.controller.snapshot.error ?? "", /Meta speech authentication failed/);
});

test("release stops capture but preserves peer, accepts one final, starts agent and ack concurrently", async () => {
	const h = harness();
	await h.capture();
	assert.equal(h.media[0]?.stopped, true);
	assert.equal(h.media[0]?.closed, false);
	assert.equal(h.releases.length, 1);
	await h.final("Open the diff and explain this");
	h.emit({ kind: "transcript", text: "duplicate final", final: true });
	h.emit({ kind: "transcript", text: "late partial", final: false });
	await wait();
	assert.equal(h.starts.length, 1);
	assert.equal(h.starts[0]?.text, "Open the diff and explain this");
	assert.equal(h.starts[0]?.screenContext.sequence, 2);
	assert.equal(h.controller.transcript, "Open the diff and explain this");
	assert.equal(h.speaks.length, 1);
	assert.deepEqual(identity(h.speaks[0] as SpeakInput), h.current());
	assert.equal(h.latencies.length, 0, "queued speech is not an audible measurement");
});

test("begin during speech closes old media; late PCM, transcripts and errors cannot affect next generation", async () => {
	const h = harness();
	await h.capture();
	await h.final();
	const old = h.current();
	h.controller.beginCapture();
	assert.equal(h.media[0]?.closed, true);
	assert.equal(h.media.length, 2);
	assert.ok(h.current().generation > old.generation);
	assert.notEqual(h.current().turnId, old.turnId);
	h.media[0]?.observer.pcm({ observedAt: 500, rms: 1, basis: "webaudio-output-analyser" });
	h.media[0]?.observer.disconnected(new Error("late disconnect"));
	await wait();
	assert.equal(h.controller.getPhase(), "listening");
	assert.equal(h.controller.transcript, "");
	assert.equal(h.latencies.length, 0);
	assert.ok(h.cancels.agent.some((cancel) => cancel.turnId === old.turnId));
});

test("cancel during agent start aborts immediately and re-cancels a late server allocation", async () => {
	const h = harness();
	const start = deferred<TurnIdentity & { status: "running" }>();
	let signal: AbortSignal | undefined;
	h.options.agent.start = (input, value) => {
		h.starts.push(AgentTurnInputSchema.parse(input));
		signal = value;
		return start.promise;
	};
	await h.capture();
	await h.final();
	const old = h.current();
	h.controller.interrupt();
	assert.equal(signal?.aborted, true);
	assert.equal(h.cancels.agent.length, 1);
	assert.equal(h.cancels.voice.length, 1);
	start.resolve({ ...old, status: "running" });
	await until(() => h.cancels.agent.length === 2);
	assert.notEqual(h.cancels.agent[0]?.requestId, h.cancels.agent[1]?.requestId);
	assert.equal(h.controller.getPhase(), "cancelled");
});

test("cancel during offer also re-cancels late signaling allocation", async () => {
	const h = harness();
	const offer = deferred<{ type: "answer"; sdp: string }>();
	h.options.voice.offer = () => offer.promise;
	h.controller.beginCapture();
	h.controller.interrupt();
	offer.resolve({ type: "answer", sdp: "late" });
	await until(() => h.cancels.voice.length === 2);
	assert.equal(h.controller.getPhase(), "cancelled");
});

test("cancel during poll drops late agent actions, speech and transcript results", async () => {
	const h = harness();
	const polled = deferred<PollTurnResult>();
	let polling = false;
	h.setPoll(() => {
		polling = true;
		return polled.promise;
	});
	await h.capture();
	await h.final();
	await until(() => polling);
	const old = h.current();
	const voicePoll = deferred<VoicePollResult>();
	h.options.voice.poll = () => voicePoll.promise;
	await wait();
	h.controller.interrupt();
	polled.resolve({
		...old,
		status: "completed",
		sequence: 2,
		text: "Late answer.",
		actions: [],
		events: [
			{ ...old, sequence: 1, kind: "text-delta", delta: "Late answer." },
			{ ...old, sequence: 2, kind: "completed" },
		],
	});
	voicePoll.resolve({
		events: [{ ...old, sequence: 99, kind: "transcript", text: "late", final: true }],
	});
	await wait();
	assert.equal(h.events.length, 0);
	assert.equal(h.speaks.length, 1);
	assert.equal(h.controller.getPhase(), "cancelled");
});

test("terminal snapshot paginates by last event, deduplicates events/actions, and speaks sentences serially", async () => {
	const h = harness();
	const cursors: number[] = [];
	h.setPoll(async (input) => {
		cursors.push(input.afterSequence);
		const turn = identity(input);
		const action: AgentAction = {
			...turn,
			requestId: "action-1",
			screenSequence: 2,
			kind: "show-diagram",
			diagramId: "diagram-1",
		};
		const all: AgentEvent[] = [
			{ ...turn, sequence: 1, kind: "acknowledgement", text: "Server acknowledgement" },
			{ ...turn, sequence: 2, kind: "text-delta", delta: "First " },
			{ ...turn, sequence: 3, kind: "text-delta", delta: "sentence. " },
			{ ...turn, sequence: 4, kind: "action", action },
			{ ...turn, sequence: 5, kind: "text-delta", delta: "Second sentence" },
			{ ...turn, sequence: 6, kind: "completed" },
		];
		return {
			...turn,
			status: "completed",
			sequence: 6,
			events: all.filter((event) => event.sequence > input.afterSequence).slice(0, 2),
			text: "First sentence. Second sentence",
			actions: [action],
		};
	});
	await h.capture();
	await h.final();
	await until(() => h.events.length === 6);
	assert.deepEqual(cursors, [0, 2, 4]);
	assert.equal(h.actions.length, 1);
	assert.equal(h.speaks.length, 1, "answer waits behind acknowledgement");
	for (let index = 0; index < 3; index++) {
		await until(() => h.speaks.length > index);
		h.emit({ kind: "speech-ended", speechId: h.speaks[index]?.speechId ?? "missing" });
	}
	await until(() => h.controller.getPhase() === "idle");
	assert.deepEqual(
		h.speaks.map((s) => s.text),
		["Acknowledged.", "First sentence.", "Second sentence"]
	);
	assert.equal(h.media[0]?.closed, true);
});

test("duplicate event pages do not repeat text or acknowledgement", async () => {
	const h = harness();
	h.setPoll(async (input) => ({
		...identity(input),
		status: "running",
		sequence: 2,
		actions: [],
		text: "One sentence. ",
		events: [
			{ ...identity(input), sequence: 1, kind: "acknowledgement", text: "Ack." },
			{ ...identity(input), sequence: 2, kind: "text-delta", delta: "One sentence. " },
		],
	}));
	await h.capture();
	await h.final();
	await wait();
	assert.equal(h.events.length, 2);
	h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
	await until(() => h.speaks.length === 2);
	await wait();
	assert.deepEqual(
		h.speaks.map((s) => s.text),
		["Acknowledged.", "One sentence."]
	);
});

test("stale screen actions are skipped and current actions are applied once", async () => {
	const ignored: Array<{ action: AgentAction; screen: ScreenContext }> = [];
	const h = harness({
		onActionIgnored: (action, screen) => {
			ignored.push({ action, screen });
		},
	});
	await h.capture();
	await h.final();
	h.setScreen({ prId: "pr-1", sequence: 3, panel: "why", focusedLocation: null });
	h.setPoll(async (input) => {
		const old: AgentAction = {
			...identity(input),
			requestId: "old",
			screenSequence: 2,
			kind: "show-diagram",
			diagramId: "diagram-1",
		};
		const current: AgentAction = { ...old, requestId: "current", screenSequence: 3 };
		return {
			...identity(input),
			status: "running",
			sequence: 2,
			text: "",
			actions: [old, current],
			events: [
				{ ...identity(input), sequence: 1, kind: "action", action: old },
				{ ...identity(input), sequence: 2, kind: "action", action: current },
			],
		};
	});
	await until(() => h.events.length === 2);
	await wait();
	assert.deepEqual(
		h.actions.map((a) => a.requestId),
		["current"]
	);
	assert.equal(ignored.length, 1, "event, snapshot and repeat polls share receipt deduplication");
	assert.equal(ignored[0]?.action.requestId, "old");
	assert.deepEqual(identity(ignored[0]?.action as AgentAction), h.current());
	assert.deepEqual(ignored[0]?.screen, {
		prId: "pr-1",
		sequence: 3,
		panel: "why",
		focusedLocation: null,
	});
});

test("same-turn actions filtered by a changed PR report ignored with the current screen", async () => {
	const ignored: ScreenContext[] = [];
	const h = harness({
		onActionIgnored: (_action, screen) => {
			ignored.push(screen);
		},
	});
	await h.capture();
	await h.final();
	const current: ScreenContext = {
		prId: "pr-2",
		sequence: 2,
		panel: "diff",
		focusedLocation: null,
	};
	h.setScreen(current);
	h.setPoll(async (input) => ({
		...identity(input),
		status: "running",
		sequence: 0,
		text: "",
		events: [],
		actions: [
			{
				...identity(input),
				requestId: "old-pr",
				screenSequence: 2,
				kind: "show-diagram",
				diagramId: "diagram-1",
			},
		],
	}));
	await until(() => ignored.length === 1);
	await wait();
	assert.deepEqual(ignored, [current]);
	assert.deepEqual(h.actions, []);
});

test("foreign session, turn and generation actions never receive an ignored receipt", async () => {
	for (const foreign of [{ sessionId: "foreign" }, { turnId: "foreign" }, { generation: 999 }]) {
		const ignored: AgentAction[] = [];
		const h = harness({
			onActionIgnored: (action) => {
				ignored.push(action);
			},
		});
		h.setPoll(async (input) => {
			const other = { ...identity(input), ...foreign };
			return {
				...other,
				status: "running",
				sequence: 0,
				text: "",
				events: [],
				actions: [
					{
						...other,
						requestId: "foreign-action",
						screenSequence: 1,
						kind: "show-diagram",
						diagramId: "diagram-1",
					},
				],
			};
		});
		await h.capture();
		await h.final();
		await until(() => h.controller.getPhase() === "error");
		assert.deepEqual(ignored, []);
		assert.deepEqual(h.actions, []);
		h.controller.dispose();
	}
});

test("cancelling a pending ignored callback stops audio and both services without later receipts", async () => {
	const receipt = deferred<void>();
	const ignored: AgentAction[] = [];
	const h = harness({
		onActionIgnored: (action) => {
			ignored.push(action);
			return receipt.promise;
		},
	});
	h.setPoll(async (input) => ({
		...identity(input),
		status: "running",
		sequence: 0,
		text: "",
		events: [],
		actions: ["first", "later"].map((requestId) => ({
			...identity(input),
			requestId,
			screenSequence: 1,
			kind: "show-diagram",
			diagramId: "diagram-1",
		})),
	}));
	await h.capture();
	await h.final();
	await until(() => ignored.length === 1);
	h.controller.interrupt("navigation");
	assert.equal(h.media[0]?.closed, true);
	assert.equal(h.cancels.voice.length, 1);
	assert.equal(h.cancels.agent.length, 1);
	receipt.resolve();
	await wait();
	assert.deepEqual(
		ignored.map((action) => action.requestId),
		["first"]
	);
	assert.deepEqual(h.actions, []);
	assert.equal(h.controller.getPhase(), "cancelled");
});

test("an ignored receipt callback that stalls is bounded and cancels the turn", async () => {
	const h = harness({ rpcTimeoutMs: 100, onActionIgnored: () => new Promise(() => {}) });
	h.setPoll(async (input) => ({
		...identity(input),
		status: "running",
		sequence: 0,
		text: "",
		events: [],
		actions: [
			{
				...identity(input),
				requestId: "stalled",
				screenSequence: 1,
				kind: "show-diagram",
				diagramId: "diagram-1",
			},
		],
	}));
	await h.capture();
	await h.final();
	await until(() => h.controller.getPhase() === "error");
	assert.equal(h.media[0]?.closed, true);
	assert.equal(h.cancels.voice.length, 1);
	assert.equal(h.cancels.agent.length, 1);
});

test("latency uses PCM observations with separate acknowledgement/answer identity and release baseline", async () => {
	const h = harness();
	await h.capture();
	await h.final();
	h.emit({ kind: "speech-started", speechId: h.speaks[0]?.speechId ?? "missing" });
	await wait();
	assert.equal(h.latencies.length, 0);
	h.media[0]?.observer.pcm({ observedAt: 145, rms: 0.2, basis: "webaudio-output-analyser" });
	h.media[0]?.observer.pcm({ observedAt: 150, rms: 0.2, basis: "webaudio-output-analyser" });
	assert.equal(h.controller.speakCompletion(h.current(), "Background result ready."), true);
	h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
	await until(() => h.speaks.length === 2);
	h.media[0]?.observer.pcm({ observedAt: 310, rms: 0.2, basis: "webaudio-output-analyser" });
	assert.deepEqual(
		h.latencies.map((l) => [l.kind, l.elapsedMs]),
		[
			["acknowledgement", 45],
			["answer", 210],
		]
	);
	assert.ok(
		h.latencies.every((l) => l.turnId === h.current().turnId && l.origin === "renderer-release")
	);
	h.controller.interrupt();
	assert.equal(h.controller.speakCompletion(h.current(), "Late background result"), false);
});

test("disconnect aborts speech and both services; disposed controller cannot restart", async () => {
	const h = harness();
	await h.capture();
	await h.final();
	h.media[0]?.observer.disconnected(new Error("offline"));
	assert.equal(h.controller.getPhase(), "error");
	assert.equal(h.cancels.agent.length, 1);
	assert.equal(h.cancels.voice.length, 1);
	assert.equal(h.media[0]?.closed, true);
	h.controller.dispose();
	h.controller.beginCapture();
	assert.equal(h.media.length, 1);
});

test("compacted events recover snapshot suffix without replaying speech", async () => {
	const h = harness();
	h.setPoll(async (input) => ({
		...identity(input),
		status: "completed",
		sequence: 50,
		text: "Recovered response.",
		actions: [],
		events: [{ ...identity(input), sequence: 50, kind: "completed" }],
	}));
	await h.capture();
	await h.final();
	await until(() => h.answers.includes("Recovered response."));
	h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
	await until(() => h.speaks.length === 2);
	assert.equal(h.speaks[1]?.text, "Recovered response.");
});

test("missing speech-ended is bounded and explicitly cancels the turn", async () => {
	const h = harness({ speechTimeoutMs: 100 });
	await h.capture();
	await h.final();
	await until(() => h.controller.getPhase() === "error");
	assert.equal(h.cancels.voice.length, 1);
	assert.equal(h.cancels.agent.length, 1);
});

test("all ids are unique and snapshots stay immutable across generations", async () => {
	const h = harness();
	await h.capture();
	await h.final();
	const first = h.controller.snapshot;
	h.controller.beginCapture();
	assert.equal(first.generation, 1);
	assert.equal(h.controller.snapshot.generation, 2);
	assert.ok(Object.isFrozen(first));
	const ids = [
		first.sessionId,
		first.turnId,
		h.controller.snapshot.turnId,
		h.starts[0]?.requestId,
		h.speaks[0]?.speechId,
		...h.cancels.agent.map((c) => c.requestId),
	];
	assert.equal(new Set(ids).size, ids.length);
});

test("setup stays idle/connecting until media is ready; keyword bias is a capture snapshot", async () => {
	const setup = deferred<void>();
	const keywords = ["calculateTotal", "src/cart.ts"];
	let offered: string[] = [];
	const h = harness({
		getKeywords: () => keywords,
		media: () => ({
			connect: async (offer) => {
				await setup.promise;
				await offer({ type: "offer", sdp: "offer" });
			},
			close: () => {},
			stopCapture: () => {},
			drain: async () => {},
		}),
	});
	h.options.voice.offer = async (input) => {
		offered = input.keywords;
		return { type: "answer", sdp: "answer" };
	};
	h.controller.beginCapture();
	assert.equal(h.controller.getPhase(), "idle");
	assert.equal(h.controller.connecting, true);
	assert.deepEqual(h.controller.getIdentity(), h.current());
	keywords.push("lateKeyword");
	setup.resolve();
	await until(() => h.controller.getPhase() === "listening");
	assert.equal(h.controller.connecting, false);
	assert.deepEqual(offered, ["calculateTotal", "src/cart.ts"]);
	h.controller.interrupt();
	assert.equal(h.controller.getIdentity(), null);
});

test("generic completion copy is injected only for a completed turn with no answer", async () => {
	const h = harness({ completionText: "Background work finished." });
	h.setPoll(async (input) => ({
		...identity(input),
		status: "completed",
		sequence: 1,
		events: [{ ...identity(input), sequence: 1, kind: "completed" }],
		text: "",
		actions: [],
	}));
	await h.capture();
	await h.final();
	h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
	await until(() => h.speaks.length === 2);
	assert.equal(h.speaks[1]?.text, "Background work finished.");
});

test("interrupt while speech RPC is in flight aborts the serial queue and late speech-ended cannot resume it", async () => {
	const h = harness();
	const submitted = deferred<void>();
	let signal: AbortSignal | undefined;
	h.options.voice.speak = (input, abort) => {
		h.speaks.push(input);
		signal = abort;
		return submitted.promise;
	};
	await h.capture();
	await h.final();
	h.controller.speakCompletion(h.current(), "Queued result.");
	h.controller.interrupt();
	assert.equal(signal?.aborted, true);
	submitted.resolve();
	h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
	await wait();
	assert.equal(h.speaks.length, 1);
	assert.equal(h.controller.getPhase(), "cancelled");
});

test("dispose invalidates before notifying listeners, so a reentrant begin cannot allocate media", () => {
	const h = harness();
	h.controller.beginCapture();
	h.controller.subscribe(() => {
		if (h.controller.getPhase() === "cancelled") h.controller.beginCapture();
	});
	h.controller.dispose();
	assert.equal(h.media.length, 1);
	assert.equal(h.media[0]?.closed, true);
});

test("shared review identity reaches one agent turn, browser action and external UI lifecycle", async () => {
	const shared = { sessionId: "review-session", turnId: "spoken-turn", generation: 4 };
	const order: string[] = [];
	const ends: Array<[TurnIdentity, VoiceTurnEnd]> = [];
	const h = harness({
		sessionId: shared.sessionId,
		allocateIdentity: () => shared,
		onTurnStart: (turn) => {
			assert.deepEqual(turn, shared);
			order.push("begin");
		},
		onTranscript: (update) => {
			assert.deepEqual(identity(update), shared);
			order.push("transcript");
		},
		onTurnEnd: (turn, result) => ends.push([turn, result]),
	});
	const browser = {
		browserId: "visible-browser",
		sessionId: shared.sessionId,
		prId: "pr-1",
		repository: "org/repo",
		commitSha: "a".repeat(40),
		revision: "head" as const,
		url: "http://127.0.0.1:1234/",
		title: "Review app",
		viewport: { width: 1024, height: 768 },
		sequence: 3,
		observedAt: "2026-10-27T19:00:00Z",
		text: "Cart",
		elements: [],
		scroll: { x: 0, y: 0 },
		provenance: "live-browser" as const,
	};
	h.setScreen({ prId: "pr-1", sequence: 2, panel: "browser", focusedLocation: null, browser });
	const action: AgentAction = {
		...shared,
		requestId: "show-current-browser",
		screenSequence: 2,
		kind: "show-browser",
		browser,
	};
	h.setPoll(async (input) => ({
		...identity(input),
		status: "completed",
		sequence: 3,
		text: "The cart is visible.",
		actions: [action],
		events: [
			{ ...shared, sequence: 1, kind: "text-delta", delta: "The cart is visible." },
			{ ...shared, sequence: 2, kind: "action", action },
			{ ...shared, sequence: 3, kind: "completed" },
		],
	}));
	await h.capture();
	await h.final("Explain this cart");
	h.emit({ kind: "transcript", text: "Duplicate", final: true });
	await until(() => h.actions.length === 1);
	assert.deepEqual(order, ["begin", "transcript"]);
	assert.equal(h.starts.length, 1);
	assert.ok(h.starts[0]);
	assert.deepEqual(identity(h.starts[0]), shared);
	assert.deepEqual(h.starts[0]?.screenContext.browser, browser);
	assert.deepEqual(h.actions, [action]);
	assert.equal(h.answers.at(-1), "The cart is visible.");
	assert.deepEqual(ends, [], "UI turn remains active while its speech is draining");
	for (let index = 0; index < 2; index++) {
		await until(() => h.speaks.length > index);
		h.emit({ kind: "speech-ended", speechId: h.speaks[index]?.speechId ?? "missing" });
	}
	await until(() => ends.length === 1);
	assert.deepEqual(ends, [[shared, { status: "completed" }]]);
	assert.deepEqual(h.cancels.voice, [shared]);
	assert.ok(h.cancels.agent[0]);
	assert.deepEqual(identity(h.cancels.agent[0]), shared);
	h.controller.dispose();
	assert.equal(ends.length, 1);
});

test("UI allocator can skip typed generations but cannot reuse or switch the review session", () => {
	let next = { sessionId: "review-session", turnId: "voice-1", generation: 4 };
	const h = harness({ sessionId: next.sessionId, allocateIdentity: () => next });
	h.controller.beginCapture();
	assert.deepEqual(h.current(), next);
	h.controller.interrupt();
	next = { ...next, turnId: "voice-2", generation: 8 };
	h.controller.beginCapture();
	assert.deepEqual(h.current(), next);
	h.controller.interrupt();
	h.controller.beginCapture();
	assert.equal(h.controller.getPhase(), "error");
	assert.equal(h.media.length, 2);
	next = { ...next, sessionId: "other-review", generation: 9 };
	h.controller.beginCapture();
	assert.equal(h.controller.getIdentity(), null);
	assert.equal(h.media.length, 2);
	assert.equal(h.errors.length, 2);
	assert.throws(() => harness({ allocateIdentity: () => next }), /requires the review session/);
});

test("a browser snapshot from another session never starts the spoken agent turn", async () => {
	const h = harness({ sessionId: "review-session" });
	h.setScreen({
		prId: "pr-1",
		sequence: 2,
		panel: "browser",
		focusedLocation: null,
		browser: {
			browserId: "other-browser",
			sessionId: "other-session",
			prId: "pr-1",
			repository: "org/repo",
			commitSha: "a".repeat(40),
			revision: "head",
			url: "http://127.0.0.1:1234/",
			title: "Old app",
			viewport: { width: 1024, height: 768 },
			sequence: 1,
			observedAt: "2026-10-27T19:00:00Z",
			text: "Old page",
			elements: [],
			scroll: { x: 0, y: 0 },
			provenance: "live-browser",
		},
	});
	await h.capture();
	await h.final();
	await until(() => h.controller.getPhase() === "error");
	assert.equal(h.starts.length, 0);
	assert.equal(h.cancels.agent.length, 1);
	assert.equal(h.cancels.voice.length, 1);
	assert.equal(h.media[0]?.closed, true);
});

test("external cancellation sink sees stopped media and both cancels once before late events", async () => {
	const ends: VoiceTurnEnd[] = [];
	const h = harness({
		onTurnEnd: (_turn, result) => {
			assert.equal(h.media[0]?.closed, true);
			assert.equal(h.cancels.voice.length, 1);
			assert.equal(h.cancels.agent.length, 1);
			ends.push(result);
		},
	});
	await h.capture();
	await h.final();
	h.controller.interrupt("navigation");
	h.controller.interrupt("escape");
	h.media[0]?.observer.disconnected(new Error("late"));
	h.emit({ kind: "transcript", text: "Late final", final: true });
	await wait();
	assert.deepEqual(ends, [{ status: "cancelled", reason: "navigation" }]);
	assert.equal(h.starts.length, 1);
});

test("external start interruption prevents media and failed turns notify their sink once", () => {
	const ends: VoiceTurnEnd[] = [];
	const h = harness({
		onTurnStart: () => h.controller.interrupt("escape"),
		onTurnEnd: (_turn, result) => {
			ends.push(result);
		},
	});
	h.controller.beginCapture();
	assert.equal(h.media.length, 0);
	assert.deepEqual(ends, [{ status: "cancelled", reason: "escape" }]);
	h.options.onTurnStart = () => {
		throw new Error("Sink unavailable");
	};
	h.controller.beginCapture();
	assert.equal(h.media.length, 0);
	assert.deepEqual(ends[1], {
		status: "failed",
		error: "Sink unavailable",
		origin: "controller",
		recoverable: false,
	});
	h.controller.dispose();
	assert.equal(ends.length, 2);
});

test("reply-only initiative uses attend without a user turn and completes only after PCM, speech-ended and drain", async () => {
	const ends: VoiceTurnEnd[] = [];
	const sources: string[] = [];
	const attends: unknown[] = [];
	const speak = deferred<void>();
	const drain = deferred<void>();
	let draining = false;
	const h = harness({
		getConversationContext: () => {
			throw new Error("Reply must not read renderer context");
		},
		onTurnStart: (_turn, source) => sources.push(source),
		onTurnEnd: (_turn, result) => ends.push(result),
	});
	h.options.agent.attend = async (input) => {
		attends.push(input);
		return { ...identity(input), status: "running" };
	};
	const factory = h.options.media;
	h.options.media = (observer) => ({
		...factory(observer),
		drain: async () => {
			draining = true;
			await drain.promise;
		},
	});
	h.options.voice.speak = async (input) => {
		h.speaks.push(input);
		await speak.promise;
	};
	h.setPoll(async (input) => ({
		...identity(input),
		status: "completed",
		sequence: 1,
		text: "The requested work is ready.",
		actions: [],
		events: [],
	}));
	const reply = h.controller.beginReply("claim-1");
	assert.equal(reply.status, "started");
	assert.deepEqual(h.controller.beginReply("claim-1"), { status: "unavailable" });
	await until(() => h.speaks.length === 1);
	assert.deepEqual(sources, ["attention"]);
	assert.deepEqual(attends, [
		{
			...h.current(),
			requestId: (attends[0] as { requestId: string }).requestId,
			claimId: "claim-1",
		},
	]);
	h.emit({ kind: "transcript", final: true, text: "Must never appear as user speech" });
	h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "" });
	await wait();
	assert.equal(draining, false);
	assert.deepEqual(ends, []);
	h.media[0]?.observer.pcm({ rms: 0.1, observedAt: 101, basis: "webaudio-output-analyser" });
	speak.resolve();
	await until(() => draining);
	assert.deepEqual(ends, []);
	drain.resolve();
	await until(() => ends.length === 1);
	assert.deepEqual(ends, [{ status: "completed" }]);
	assert.deepEqual(h.starts, []);
	assert.deepEqual(h.releases, []);
	assert.equal(h.controller.transcript, "");
	assert.equal(h.media[0]?.stopped, true);
	const previous = reply.status === "started" ? reply.identity : null;
	h.controller.beginCapture();
	assert.equal(h.current().sessionId, previous?.sessionId);
	assert.ok(h.current().generation > (previous?.generation ?? 0));
});

test("an attention answer without observed output PCM fails instead of claiming delivery", async () => {
	const ends: VoiceTurnEnd[] = [];
	const h = harness({ onTurnEnd: (_turn, result) => ends.push(result) });
	h.options.agent.attend = async (input) => ({ ...identity(input), status: "running" });
	h.setPoll(async (input) => ({
		...identity(input),
		status: "completed",
		sequence: 1,
		text: "Ready.",
		actions: [],
		events: [],
	}));
	h.controller.beginReply("claim-silent");
	await until(() => h.speaks.length === 1);
	h.emit({ kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "" });
	await until(() => ends.length === 1);
	assert.equal(ends[0]?.status, "failed");
	assert.equal(h.cancels.voice.length, 1);
	assert.equal(h.cancels.agent.length, 1);
});

test("attention refuses pane actions and an empty response never becomes completion filler", async () => {
	for (const withAction of [false, true]) {
		const ends: VoiceTurnEnd[] = [];
		const h = harness({
			completionText: "Generic completion.",
			onTurnEnd: (_turn, result) => ends.push(result),
		});
		h.options.agent.attend = async (input) => ({ ...identity(input), status: "running" });
		h.setPoll(async (input) => ({
			...identity(input),
			status: "completed",
			sequence: 1,
			text: "",
			events: [],
			actions: withAction
				? [
						{
							...identity(input),
							requestId: "navigation",
							kind: "narration-checkpoint",
							screenSequence: 2,
							throughTextLength: 0,
						},
					]
				: [],
		}));
		h.controller.beginReply(`claim-${withAction}`);
		await until(() => ends.length === 1);
		assert.equal(ends[0]?.status, "failed");
		assert.deepEqual(h.speaks, []);
		assert.deepEqual(h.actions, []);
	}
});

test("cancelled assistant allocation compensates its late attend result and cannot revive speech", async () => {
	const pending = deferred<TurnIdentity & { status: "running" }>();
	const h = harness();
	let old: TurnIdentity | null = null;
	h.options.agent.attend = async (input) => {
		old = identity(input);
		return pending.promise;
	};
	h.controller.beginReply("claim-late");
	await until(() => old !== null);
	h.controller.interrupt("push-to-talk");
	h.controller.beginCapture();
	const next = h.current();
	assert.ok(old);
	pending.resolve({ ...identity(old), status: "running" });
	await wait();
	assert.deepEqual(h.controller.getIdentity(), next);
	assert.equal(h.cancels.agent.filter((turn) => turn.turnId === old?.turnId).length, 2);
	assert.deepEqual(h.speaks, []);
});

for (const stage of ["connect", "speech", "drain"] as const) {
	test(`reply cancellation during ${stage} prevents late completion and preserves the next generation`, async () => {
		const held = deferred<void>();
		const ends: Array<{ turn: TurnIdentity; result: VoiceTurnEnd }> = [];
		const h = harness({ onTurnEnd: (turn, result) => ends.push({ turn, result }) });
		h.options.agent.attend = async (input) => ({ ...identity(input), status: "running" });
		const factory = h.options.media;
		let reached = false;
		h.options.media = (observer) => {
			const media = factory(observer);
			return {
				...media,
				connect: async (offer, signal) => {
					await media.connect(offer, signal);
					if (stage === "connect") {
						reached = true;
						await held.promise;
					}
				},
				drain: async () => {
					if (stage === "drain") {
						reached = true;
						await held.promise;
					}
				},
			};
		};
		h.options.voice.speak = async (input) => {
			h.speaks.push(input);
			h.media[0]?.observer.pcm({ rms: 0.1, observedAt: 101, basis: "webaudio-output-analyser" });
			h.emit({ kind: "speech-ended", speechId: input.speechId });
			if (stage === "speech") {
				reached = true;
				await held.promise;
			}
		};
		h.setPoll(async (input) => ({
			...identity(input),
			status: "completed",
			sequence: 1,
			text: "First notice. Second notice.",
			actions: [],
			events: [],
		}));
		const reply = h.controller.beginReply(`claim-${stage}`);
		assert.equal(reply.status, "started");
		await until(() => reached);
		h.controller.interrupt("push-to-talk");
		h.controller.beginCapture();
		const next = h.current();
		held.resolve();
		await wait();
		assert.deepEqual(h.controller.getIdentity(), next);
		assert.equal(ends.length, 1);
		assert.equal(ends[0]?.result.status, "cancelled");
		assert.ok(h.speaks.length <= 1, "No queued second notice after cancellation");
		assert.equal(h.media[0]?.closed, true);
		assert.equal(h.releases.length, 0);
	});
}
