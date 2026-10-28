import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { SpeakInput, VoiceEvent } from "../../main/voice/protocol";
import type {
	AgentAction,
	ConversationTurnInput,
	PollTurnResult,
	TurnIdentity,
} from "../../shared/contracts";
import { createHandsFreeVoiceController } from "./hands-free";
import type {
	HandsFreeAudioFactory,
	HandsFreeOptions,
	HandsFreeVoiceController,
} from "./hands-free-types";
import type { MediaFactory, VoiceTurnEnd } from "./types";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 1500;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "condition timed out");
		await pause(2);
	}
}
const owned: HandsFreeVoiceController[] = [];
afterEach(() => {
	for (const voice of owned.splice(0)) voice.dispose();
});
function identity(value: TurnIdentity) {
	return { sessionId: value.sessionId, turnId: value.turnId, generation: value.generation };
}
function tone(frequency = 440, amplitude = 0.1) {
	return Float32Array.from(
		{ length: 960 },
		(_, i) => amplitude * Math.sin((i * 2 * Math.PI * frequency) / 48000)
	);
}
function navigation(turn: TurnIdentity): AgentAction {
	return {
		...identity(turn),
		kind: "review-navigation",
		requestId: "failed-action",
		screenSequence: 1,
		navigation: {
			prId: "pr-1",
			reviewId: "review-1",
			path: "src/main.ts",
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
			paused: false,
		},
	};
}
function harness(extra: Partial<HandsFreeOptions> = {}) {
	let now = 0;
	let ids = 0;
	const sessions: {
		observer: Parameters<HandsFreeAudioFactory>[0];
		closed: boolean;
		opens: number;
	}[] = [];
	const turns: {
		observer: Parameters<MediaFactory>[0];
		samples: Float32Array[];
		closed: boolean;
		ended: boolean;
		connected: boolean;
		ready: ReturnType<typeof deferred<void>>;
		drain: ReturnType<typeof deferred<void>>;
	}[] = [];
	const starts: ConversationTurnInput[] = [];
	const releases: TurnIdentity[] = [];
	const cancels = { voice: [] as TurnIdentity[], agent: [] as TurnIdentity[] };
	const speaks: SpeakInput[] = [];
	const errors: Error[] = [];
	const ends: Array<{ identity: TurnIdentity; result: VoiceTurnEnd }> = [];
	const events = new Map<string, VoiceEvent[]>();
	let open = async () => {};
	let cancellation = async () => {};
	let delayConnect = false;
	let autoDrain = true;
	let finishSpeech = true;
	let transcript = "Hello";
	function emit(
		turn: TurnIdentity,
		event:
			| { kind: "transcript"; text: string; final: boolean }
			| { kind: "speech-ended"; speechId: string }
	) {
		const list = events.get(turn.turnId) ?? [];
		events.set(turn.turnId, list);
		list.push({ ...identity(turn), sequence: list.length + 1, ...event });
	}
	const audio: HandsFreeAudioFactory = (observer) => {
		const session = { observer, closed: false, opens: 0 };
		sessions.push(session);
		return {
			start: async () => {
				session.opens++;
				await open();
			},
			close: () => {
				session.closed = true;
			},
			createTurn: (observer) => {
				const turn = {
					observer,
					samples: [] as Float32Array[],
					closed: false,
					ended: false,
					connected: false,
					ready: deferred<void>(),
					drain: deferred<void>(),
				};
				turns.push(turn);
				void turn.drain.promise.catch(() => {});
				const maybeDrain = () => {
					if (autoDrain && turn.connected && turn.ended) setTimeout(() => turn.drain.resolve(), 0);
				};
				return {
					connect: async (offer) => {
						await offer({ type: "offer", sdp: "synthetic" });
						if (delayConnect) await turn.ready.promise;
						turn.connected = true;
						maybeDrain();
					},
					append: (samples) => {
						assert.equal(turn.ended, false);
						turn.samples.push(samples.slice());
					},
					finishInput: () => {
						turn.ended = true;
						maybeDrain();
						return turn.drain.promise;
					},
					stopCapture: () => {},
					drain: async () => {},
					close: () => {
						turn.closed = true;
						turn.drain.reject(new Error("closed"));
					},
				};
			},
		};
	};
	const options: HandsFreeOptions = {
		sessionId: "shared-conversation",
		id: () => `id-${++ids}`,
		now: () => now,
		pollIntervalMs: 10,
		getConversationContext: () => ({}),
		audio,
		onError: (error) => {
			errors.push(error);
		},
		onTurnEnd: (identity, result) => ends.push({ identity, result }),
		voice: {
			offer: async () => ({ type: "answer", sdp: "synthetic" }),
			release: async (input) => {
				releases.push(input);
				emit(input, { kind: "transcript", text: transcript, final: true });
			},
			poll: async (input) => ({
				events: (events.get(input.turnId) ?? []).filter(
					(event) => event.sequence > input.afterSequence
				),
			}),
			speak: async (input) => {
				speaks.push(input);
				if (finishSpeech) emit(input, { kind: "speech-ended", speechId: input.speechId });
			},
			cancel: async (input) => {
				cancels.voice.push(input);
				await cancellation();
			},
		},
		agent: {
			start: async (input) => {
				starts.push(input);
				return { ...identity(input), status: "running" };
			},
			poll: async (input) => ({
				...identity(input),
				status: "completed",
				text: "Hello back.",
				sequence: 2,
				actions: [],
				events: [
					{ ...identity(input), kind: "text-delta", sequence: 1, delta: "Hello back." },
					{ ...identity(input), kind: "completed", sequence: 2 },
				],
			}),
			cancel: async (input) => {
				cancels.agent.push(identity(input));
				return { ...identity(input), requestId: input.requestId, status: "cancelled" };
			},
		},
		...extra,
	};
	const voice = createHandsFreeVoiceController(options);
	owned.push(voice);
	return {
		voice,
		options,
		sessions,
		turns,
		starts,
		releases,
		speaks,
		cancels,
		errors,
		ends,
		emit,
		setTranscript: (text: string) => {
			transcript = text;
		},
		setOpen: (fn: typeof open) => {
			open = fn;
		},
		setCancellation: (fn: typeof cancellation) => {
			cancellation = fn;
		},
		setConnectDelay: () => {
			delayConnect = true;
			autoDrain = false;
		},
		keepSpeaking: () => {
			finishSpeech = false;
		},
		setTime: (value: number) => {
			now = value;
		},
		feed(
			samples = new Float32Array(960),
			reference = new Float32Array(960),
			count = 1,
			session = sessions.at(-1)
		) {
			assert.ok(session);
			for (let i = 0; i < count; i++) {
				now += 20;
				session.observer.frame({ samples, reference, sampleRate: 48000 });
			}
		},
	};
}
test("one explicit start owns the microphone across silence-endpointed reply cycles with no filler", async () => {
	const h = harness();
	await h.voice.startListening();
	await h.voice.startListening();
	assert.equal(h.sessions.length, 1);
	for (let i = 0; i < 2; i++) {
		h.feed(tone(), undefined, 15);
		h.feed(undefined, undefined, 35);
		await until(
			() => h.starts.length === i + 1 && h.voice.getSessionSnapshot().phase === "listening"
		);
		assert.equal(h.sessions[0]?.closed, false);
		assert.equal(h.turns[i]?.closed, true);
	}
	assert.equal(h.sessions[0]?.opens, 1);
	assert.deepEqual(
		h.speaks.map((speech) => speech.text),
		["Hello back.", "Hello back."]
	);
	assert.ok(h.starts[1] && h.starts[0] && h.starts[1].generation > h.starts[0].generation);
	h.voice.stopListening();
	assert.equal(h.sessions[0]?.closed, true);
	h.feed(tone(), undefined, 20);
	await pause();
	assert.equal(h.turns.length, 2);
	assert.equal(h.voice.getSessionSnapshot().phase, "stopped");
});
test("short utterance ending before peer readiness preserves first PCM and waits for FIFO drain", async () => {
	const h = harness();
	h.setConnectDelay();
	await h.voice.startListening();
	const prefix = tone(220);
	h.feed(prefix, undefined, 5);
	h.feed(tone(), undefined, 10);
	h.feed(undefined, undefined, 35);
	assert.equal(h.turns.length, 1);
	const turn = h.turns[0];
	assert.ok(turn);
	assert.equal(turn.ended, true);
	assert.deepEqual(turn.samples[0], prefix);
	assert.equal(turn.samples.length, 50);
	assert.deepEqual(h.releases, []);
	turn.ready.resolve();
	await until(() => h.voice.getPhase() === "listening");
	assert.deepEqual(h.releases, []);
	turn.drain.resolve();
	await until(() => h.starts.length === 1);
	assert.equal(h.releases.length, 1);
});
test("correlated playback is not retransmitted; user barge-in closes old audio and cancels its identity", async () => {
	const h = harness();
	h.keepSpeaking();
	await h.voice.startListening();
	h.feed(tone(), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => h.voice.getPhase() === "speaking");
	const old = h.voice.getIdentity();
	assert.ok(old);
	const playback = tone(660, 0.2);
	h.feed(
		Float32Array.from(playback, (sample) => sample * 0.3),
		playback,
		5
	);
	assert.equal(h.turns.length, 1);
	h.feed(tone(440, 0.15), playback, 16);
	assert.equal(h.turns.length, 2);
	assert.equal(h.turns[0]?.closed, true);
	assert.ok(h.cancels.voice.some((turn) => turn.turnId === old.turnId));
	assert.ok(h.cancels.agent.some((turn) => turn.turnId === old.turnId));
	assert.equal(h.sessions[0]?.opens, 1);
	assert.equal(h.sessions[0]?.closed, false);
	assert.ok(
		h.turns[1]?.samples[0]?.every((sample) => sample === 0),
		"Echo-only preroll is zeroed"
	);
	const firstUser = h.turns[1]?.samples.find((samples) => samples.some((sample) => sample !== 0));
	const userSignal = tone(440, 0.15);
	assert.ok(
		firstUser?.every((sample, i) => sample === userSignal[i]),
		"No earlier playback echo is replayed"
	);
	assert.ok((h.voice.getIdentity()?.generation ?? 0) > old.generation);
});
test("stop during pending permission, error and dispose never auto-rearm on late callbacks", async () => {
	const h = harness();
	const permission = deferred<void>();
	h.setOpen(() => permission.promise);
	const opening = h.voice.startListening();
	const rejected = assert.rejects(opening, { name: "AbortError" });
	h.voice.stopListening();
	permission.resolve();
	await rejected;
	h.feed(tone(), undefined, 20);
	assert.equal(h.voice.getSessionSnapshot().phase, "stopped");
	assert.equal(h.turns.length, 0);
	assert.equal(h.sessions[0]?.closed, true);
	h.setOpen(async () => {});
	await h.voice.startListening();
	h.sessions[1]?.observer.failed(new Error("Synthetic audio failure"));
	assert.equal(h.sessions[1]?.closed, true);
	assert.equal(h.voice.getSessionSnapshot().phase, "error");
	h.feed(tone(), undefined, 20);
	assert.equal(h.turns.length, 0);
	h.voice.dispose();
	await assert.rejects(h.voice.startListening(), { name: "AbortError" });
});

test("VAD barge-in drops a pending narration checkpoint while the same microphone session captures the next user", async () => {
	let checkpoints = 0;
	let ui = 0;
	const text = "Narration still playing";
	const h = harness({
		onNarrationCheckpoint: () => {
			checkpoints++;
		},
		onConversationAction: () => {
			ui++;
		},
	});
	const normalPoll = h.options.agent.poll;
	h.options.agent.poll = async (input) => ({
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
				action: {
					...identity(input),
					screenSequence: 1,
					requestId: "pending-narration",
					kind: "narration-checkpoint",
					throughTextLength: text.length,
				},
			},
			{ ...identity(input), sequence: 3, kind: "action", action: navigation(input) },
		],
		actions: [],
	});
	h.keepSpeaking();
	await h.voice.startListening();
	h.feed(tone(), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => h.speaks.length === 1);
	const old = h.voice.getIdentity();
	assert.ok(old);
	h.feed(tone(330, 0.15), tone(660, 0.2), 16);
	assert.equal(h.turns.length, 2, "VAD immediately begins the distinct user utterance");
	assert.equal(h.turns[0]?.closed, true);
	assert.equal(h.sessions[0]?.closed, false);
	assert.equal(h.sessions[0]?.opens, 1);
	assert.ok(h.cancels.voice.some((turn) => turn.turnId === old.turnId));
	assert.ok(h.cancels.agent.some((turn) => turn.turnId === old.turnId));
	const next = h.voice.getIdentity();
	assert.ok(next && next.generation > old.generation);
	h.emit(old, { kind: "speech-ended", speechId: h.speaks[0]?.speechId ?? "missing" });
	h.options.agent.poll = normalPoll;
	h.setTranscript("A real follow-up question");
	h.feed(undefined, undefined, 35);
	await until(() => h.speaks.length === 2);
	assert.equal(h.starts[1]?.text, "A real follow-up question");
	h.emit(next, { kind: "speech-ended", speechId: h.speaks[1]?.speechId ?? "missing" });
	await until(() => h.voice.getSessionSnapshot().phase === "listening");
	assert.equal(checkpoints, 0);
	assert.equal(ui, 0);
	assert.equal(h.starts.length, 2);
	assert.equal(h.sessions.length, 1);
	assert.equal(h.sessions[0]?.closed, false);
	assert.deepEqual(h.errors, []);
});

test("narration receipt failure preserves healthy hands-free capture without retry or filler", async () => {
	const failure = new Error("Narration receipt failed");
	const text = "First file narration";
	const h = harness({
		onNarrationCheckpoint: () => {
			throw failure;
		},
		completionText: "Extra completion must not play.",
	});
	const normalPoll = h.options.agent.poll;
	h.options.agent.poll = async (input) => ({
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
				action: {
					...identity(input),
					screenSequence: 1,
					requestId: "failed-narration",
					kind: "narration-checkpoint",
					throughTextLength: text.length,
				},
			},
		],
		actions: [],
	});
	await h.voice.startListening();
	h.feed(tone(), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => h.ends.length === 1 && h.errors.length === 1);
	assert.deepEqual(h.ends[0]?.result, {
		status: "failed",
		error: failure.message,
		origin: "agent",
		recoverable: true,
	});
	assert.equal(h.errors[0], failure);
	assert.equal(h.turns[0]?.closed, true);
	assert.equal(h.sessions[0]?.closed, false);
	assert.equal(h.voice.getSessionSnapshot().phase, "listening");
	h.feed(undefined, undefined, 40);
	await pause(35);
	assert.equal(h.starts.length, 1, "Silence never injects a continuation utterance");
	h.options.agent.poll = normalPoll;
	h.setTranscript("A different user question");
	h.feed(tone(330), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => h.ends.length === 2);
	assert.deepEqual(h.ends[1]?.result, { status: "completed" });
	assert.deepEqual(
		h.speaks.map((speech) => speech.text),
		[text, "Hello back."]
	);
	assert.equal(h.sessions.length, 1);
	assert.equal(h.sessions[0]?.closed, false);
	assert.equal(h.errors.length, 1);
});
test("continuous noise, idle silence and stalled capture terminate the session", async () => {
	const continuous = harness({ activity: { maxUtteranceMs: 1000 } });
	await continuous.voice.startListening();
	continuous.feed(tone(), undefined, 60);
	assert.equal(continuous.voice.getSessionSnapshot().phase, "error");
	assert.equal(continuous.sessions[0]?.closed, true);
	const idle = harness({ idleTimeoutMs: 100 });
	await idle.voice.startListening();
	idle.feed(undefined, undefined, 10);
	await until(() => idle.voice.getSessionSnapshot().phase === "stopped");
	assert.equal(idle.turns.length, 0);
	const stalled = harness({ frameTimeoutMs: 100 });
	await stalled.voice.startListening();
	stalled.setTime(500);
	await until(() => stalled.voice.getSessionSnapshot().phase === "error");
	assert.equal(stalled.sessions[0]?.closed, true);
});

test("quiet reading has no default automatic session cutoff", async () => {
	const h = harness();
	await h.voice.startListening();
	h.setTime(45 * 60_000);
	h.feed();
	await pause(120);
	assert.equal(h.voice.getSessionSnapshot().phase, "listening");
	assert.equal(h.sessions[0]?.closed, false);
	assert.equal(h.starts.length, 0);
});

test("reentrant stop while starting cannot start hardware or rearm", async () => {
	const h = harness();
	h.voice.subscribe(() => {
		if (h.voice.getSessionSnapshot().phase === "starting") h.voice.stopListening();
	});
	await assert.rejects(h.voice.startListening(), { name: "AbortError" });
	assert.equal(h.sessions[0]?.closed, true);
	assert.equal(h.sessions[0]?.opens, 0);
	assert.equal(h.voice.getSessionSnapshot().phase, "stopped");
});

test("late retired-turn cancellation failure cannot close a new hardware session before its first turn", async () => {
	const h = harness();
	const cancelled = deferred<void>();
	h.setCancellation(() => cancelled.promise);
	await h.voice.startListening();
	h.feed(tone(), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(
		() => h.cancels.voice.length === 1 && h.voice.getSessionSnapshot().phase === "listening"
	);
	h.voice.stopListening();
	await h.voice.startListening();
	assert.equal(h.sessions[0]?.closed, true);
	assert.equal(h.sessions[1]?.closed, false);
	assert.equal(h.voice.getIdentity(), null);
	cancelled.reject(new Error("Late old cancellation failure"));
	await pause(25);
	assert.equal(h.sessions[1]?.closed, false);
	assert.equal(h.voice.getSessionSnapshot().phase, "listening");
	assert.deepEqual(h.errors, []);
});

test("near-pitch barge-in retains its first independent PCM frame in the next turn", async () => {
	const h = harness();
	h.keepSpeaking();
	await h.voice.startListening();
	h.feed(tone(), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => h.voice.getPhase() === "speaking");
	const chirp = (index: number, base: number, amplitude: number) =>
		Float32Array.from({ length: 960 }, (_, i) => {
			const time = (index * 960 + i) / 48000;
			return amplitude * Math.sin(2 * Math.PI * (base * time + 3 * time * time));
		});
	for (let i = 0; i < 6; i++) h.feed(undefined, chirp(i, 180, 0.2));
	const firstWord = chirp(6, 188, 0.12);
	for (let i = 6; i < 24; i++) h.feed(chirp(i, 188, 0.12), chirp(i, 180, 0.2));
	assert.equal(h.turns.length, 2);
	const firstRetained = h.turns[1]?.samples.find((samples) =>
		samples.some((sample) => sample !== 0)
	);
	assert.ok(
		firstRetained?.every((sample, i) => sample === firstWord[i]),
		"First independent PCM frame retained intact"
	);
});

for (const failure of ["start", "poll", "model", "action"] as const) {
	test(`agent ${failure} failure preserves capture for a distinct utterance without retry`, async () => {
		const failureError = new Error("Same message for every failure origin");
		const h = harness({
			onConversationAction: () => {
				throw failureError;
			},
		});
		const start = h.options.agent.start;
		const poll = h.options.agent.poll;
		let starts = 0;
		let polls = 0;
		h.options.agent.start = async (input, signal) => {
			starts++;
			if (failure === "start") throw failureError;
			return start(input, signal);
		};
		h.options.agent.poll = async (input) => {
			polls++;
			if (failure === "poll") throw failureError;
			const action = navigation(input);
			return {
				...identity(input),
				status: failure === "model" ? "error" : "running",
				text: "",
				sequence: 1,
				actions: [],
				events:
					failure === "model"
						? [{ ...identity(input), kind: "error", sequence: 1, message: failureError.message }]
						: [{ ...identity(input), kind: "action", sequence: 1, action }],
			};
		};
		await h.voice.startListening();
		h.feed(tone(), undefined, 15);
		h.feed(undefined, undefined, 35);
		await until(() => h.ends.length === 1 && h.errors.length === 1);
		const failed = h.ends[0];
		assert.ok(failed);
		assert.deepEqual(failed.result, {
			status: "failed",
			error: failureError.message,
			origin: "agent",
			recoverable: true,
		});
		if (failure !== "model") assert.equal(h.errors[0], failureError);
		assert.equal(h.voice.getSessionSnapshot().phase, "listening");
		assert.equal(h.voice.getSessionSnapshot().active, true);
		assert.equal(h.sessions[0]?.closed, false);
		assert.equal(h.turns[0]?.closed, true);
		assert.ok(h.cancels.voice.some((value) => value.turnId === failed.identity.turnId));
		assert.ok(h.cancels.agent.some((value) => value.turnId === failed.identity.turnId));
		h.feed(undefined, undefined, 40);
		await pause(35);
		assert.equal(starts, 1, "No automatic request retry");
		assert.equal(polls, failure === "start" ? 0 : 1);
		assert.equal(h.turns.length, 1, "Silence cannot allocate another turn");
		h.options.agent.start = start;
		h.options.agent.poll = poll;
		h.setTranscript("A different user question");
		h.feed(tone(330), undefined, 15);
		h.feed(undefined, undefined, 35);
		await until(() => h.ends.length === 2);
		assert.deepEqual(h.ends[1]?.result, { status: "completed" });
		assert.equal(h.starts.at(-1)?.text, "A different user question");
		assert.notEqual(h.ends[1]?.identity.turnId, failed.identity.turnId);
		assert.ok((h.ends[1]?.identity.generation ?? 0) > failed.identity.generation);
		assert.equal(h.sessions.length, 1);
		assert.equal(h.sessions[0]?.opens, 1);
		assert.equal(h.sessions[0]?.closed, false);
		assert.equal(h.errors.length, 1);
		assert.deepEqual(
			h.speaks.map((speech) => speech.text),
			["Hello back."]
		);
	});
}

test("a failed agent stream stops output and queue without completing partial speech or accepting late events", async () => {
	const h = harness({ completionText: "Completed successfully." });
	const failed = deferred<PollTurnResult>();
	const lateVoice = deferred<{ events: VoiceEvent[] }>();
	const cancel = deferred<void>();
	const speech = deferred<void>();
	let speechSignal: AbortSignal | undefined;
	const normalVoicePoll = h.options.voice.poll;
	const normalSpeak = h.options.voice.speak;
	let polls = 0;
	let voiceHeld = false;
	h.keepSpeaking();
	h.options.voice.speak = async (input, signal) => {
		speechSignal = signal;
		await normalSpeak(input, signal);
		await speech.promise;
	};
	h.setCancellation(() => cancel.promise);
	h.options.agent.poll = async (input) => {
		if (++polls > 1) return failed.promise;
		voiceHeld = true;
		return {
			...identity(input),
			status: "running",
			sequence: 1,
			actions: [],
			text: "First sentence. Queued sentence. unfinished",
			events: [
				{
					...identity(input),
					kind: "text-delta",
					sequence: 1,
					delta: "First sentence. Queued sentence. unfinished",
				},
			],
		};
	};
	h.options.voice.poll = (input, signal) =>
		voiceHeld ? lateVoice.promise : normalVoicePoll(input, signal);
	await h.voice.startListening();
	h.feed(tone(), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => h.speaks.length === 1 && polls === 2);
	const old = h.voice.getIdentity();
	assert.ok(old);
	failed.reject(new Error("Model response incomplete; please ask again."));
	await until(() => h.ends.length === 1);
	assert.equal(h.turns[0]?.closed, true);
	assert.equal(h.sessions[0]?.closed, false);
	assert.equal(h.voice.getSessionSnapshot().phase, "listening");
	assert.equal(h.cancels.voice.length, 1);
	assert.equal(h.cancels.agent.length, 1);
	assert.equal(speechSignal?.aborted, true);
	speech.resolve();
	lateVoice.resolve({
		events: [
			{ ...old, kind: "speech-ended", sequence: 2, speechId: h.speaks[0]?.speechId ?? "missing" },
			{ ...old, kind: "transcript", sequence: 3, text: "late transcript", final: true },
		],
	});
	h.turns[0]?.observer.disconnected(new Error("late RTC error"));
	cancel.reject(new Error("late cancellation error"));
	await pause(35);
	assert.equal(h.speaks.length, 1, "No queued sentence, partial tail or completion speech");
	assert.equal(polls, 2);
	assert.equal(h.ends.length, 1);
	assert.equal(h.errors.length, 1);
	assert.equal(h.sessions[0]?.closed, false);
});

test("an error snapshot never speaks its partial answer or applies its actions", async () => {
	let actions = 0;
	const h = harness({
		completionText: "Done.",
		onConversationAction: () => {
			actions++;
		},
	});
	h.options.agent.poll = async (input) => ({
		...identity(input),
		status: "error",
		sequence: 1,
		text: "This should never be spoken.",
		actions: [navigation(input)],
		events: [
			{
				...identity(input),
				kind: "text-delta",
				sequence: 1,
				delta: "This should never be spoken.",
			},
		],
	});
	await h.voice.startListening();
	h.feed(tone(), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => h.ends.length === 1);
	assert.deepEqual(h.speaks, []);
	assert.equal(actions, 0);
	assert.equal(h.voice.getSessionSnapshot().phase, "listening");
});

for (const source of ["media", "offer", "release", "poll", "stt", "tts", "controller"] as const) {
	test(`${source} failure is fatal regardless of its message and never rearms`, async () => {
		const failure = new Error("Same message for every failure origin");
		const h = harness({
			...(source === "controller"
				? {
						getConversationContext: () => {
							throw failure;
						},
					}
				: {}),
		});
		if (source === "offer")
			h.options.voice.offer = async () => {
				throw failure;
			};
		if (source === "release")
			h.options.voice.release = async () => {
				throw failure;
			};
		if (source === "poll")
			h.options.voice.poll = async () => {
				throw failure;
			};
		if (source === "stt")
			h.options.voice.poll = async (input) => ({
				events: [{ ...identity(input), kind: "error", sequence: 1, message: failure.message }],
			});
		if (source === "tts")
			h.options.voice.speak = async () => {
				throw failure;
			};
		await h.voice.startListening();
		h.feed(tone(), undefined, 15);
		if (source === "media") h.sessions[0]?.observer.failed(failure);
		else h.feed(undefined, undefined, 35);
		await until(() => h.ends.length === 1 && h.errors.length === 1);
		assert.deepEqual(h.ends[0]?.result, {
			status: "failed",
			error: failure.message,
			origin: source === "media" ? "media" : source === "controller" ? "controller" : "voice",
			recoverable: false,
		});
		assert.equal(h.sessions[0]?.closed, true);
		assert.equal(h.voice.getSessionSnapshot().phase, "error");
		assert.equal(h.turns[0]?.closed, true);
		assert.ok(
			h.cancels.voice.length >= 1,
			"Late media allocation may require a compensating cancel"
		);
		assert.ok(h.cancels.agent.length >= 1);
		h.feed(tone(), undefined, 40);
		await pause(25);
		assert.equal(h.sessions.length, 1);
		assert.equal(h.turns.length, 1);
		assert.equal(h.ends.length, 1);
		assert.equal(h.errors.length, 1);
	});
}

test("recoverable reports do not suppress a later fatal device error on the same session", async () => {
	const h = harness();
	const normalPoll = h.options.agent.poll;
	h.options.agent.poll = async () => {
		throw new Error("agent failure");
	};
	await h.voice.startListening();
	h.feed(tone(), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => h.errors.length === 1);
	h.options.agent.poll = normalPoll;
	h.feed(tone(330), undefined, 15);
	assert.ok(h.voice.getIdentity(), "Later fatal failure runs through the per-turn reporting fence");
	h.sessions[0]?.observer.failed(new Error("device lost"));
	assert.equal(h.sessions[0]?.closed, true);
	assert.equal(h.voice.getSessionSnapshot().phase, "error");
	assert.deepEqual(
		h.errors.map((error) => error.message),
		["agent failure", "device lost"]
	);
});

test("recoverable end can stop and restart explicitly without its report or old callbacks affecting new hardware", async () => {
	let restart: Promise<void> | undefined;
	const h = harness({
		onTurnEnd: (_identity, result) => {
			if (result.status === "failed" && result.recoverable) {
				h.voice.stopListening();
				restart = h.voice.startListening();
			}
		},
	});
	h.options.agent.poll = async () => {
		throw new Error("retired agent failure");
	};
	await h.voice.startListening();
	h.feed(tone(), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => restart !== undefined);
	await restart;
	h.turns[0]?.observer.disconnected(new Error("old RTC failure"));
	h.sessions[0]?.observer.failed(new Error("old hardware failure"));
	await pause(25);
	assert.equal(h.sessions[0]?.closed, true);
	assert.equal(h.sessions[1]?.closed, false);
	assert.equal(h.voice.getSessionSnapshot().phase, "listening");
	assert.deepEqual(h.errors, []);
});

test("unknown answer callback errors inside the agent loop remain fatal", async () => {
	const h = harness({
		onAnswer: () => {
			throw new Error("Model response incomplete; please ask again.");
		},
	});
	await h.voice.startListening();
	h.feed(tone(), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => h.ends.length === 1 && h.errors.length === 1);
	assert.deepEqual(h.ends[0]?.result, {
		status: "failed",
		error: "Model response incomplete; please ask again.",
		origin: "controller",
		recoverable: false,
	});
	assert.equal(h.sessions[0]?.closed, true);
	assert.equal(h.voice.getSessionSnapshot().phase, "error");
	assert.deepEqual(h.speaks, []);
});

test("a turn-end hook error remains fatal even while reporting a recoverable agent failure", async () => {
	const h = harness({
		onTurnEnd: () => {
			throw new Error("controller failed");
		},
	});
	h.options.agent.poll = async () => {
		throw new Error("agent failed");
	};
	await h.voice.startListening();
	h.feed(tone(), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => h.errors.length === 1);
	assert.equal(h.errors[0]?.message, "controller failed");
	assert.equal(h.sessions[0]?.closed, true);
	assert.equal(h.voice.getSessionSnapshot().phase, "error");
});

test("late failed-turn callbacks and cancellation cannot stop the next utterance in the same hardware session", async () => {
	const h = harness();
	const normalPoll = h.options.agent.poll;
	const cancellation = deferred<void>();
	h.setCancellation(() => cancellation.promise);
	h.options.agent.poll = async () => {
		throw new Error("first agent failure");
	};
	await h.voice.startListening();
	h.feed(tone(), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => h.errors.length === 1);
	const old = h.ends[0]?.identity;
	assert.ok(old);
	h.options.agent.poll = normalPoll;
	h.keepSpeaking();
	h.feed(tone(330), undefined, 15);
	h.feed(undefined, undefined, 35);
	await until(() => h.voice.getPhase() === "speaking");
	const current = h.voice.getIdentity();
	assert.ok(current);
	cancellation.reject(new Error("old cancellation failed"));
	h.turns[0]?.observer.disconnected(new Error("old RTC failed"));
	h.emit(old, { kind: "transcript", text: "late failed-turn transcript", final: true });
	await pause(30);
	assert.deepEqual(h.voice.getIdentity(), current);
	assert.equal(h.sessions.length, 1);
	assert.equal(h.sessions[0]?.closed, false);
	assert.equal(h.turns[1]?.closed, false);
	assert.equal(h.errors.length, 1);
	assert.equal(h.ends.length, 1);
	assert.equal(h.starts.length, 2);
});
