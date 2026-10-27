import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { SpeakInput, VoiceEvent, VoicePollResult } from "../../main/voice/protocol";
import type {
	AgentAction,
	AgentEvent,
	AgentTurnInput,
	CancelTurnInput,
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
				starts.push(input);
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
		h.starts.push(input);
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
	const h = harness();
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
