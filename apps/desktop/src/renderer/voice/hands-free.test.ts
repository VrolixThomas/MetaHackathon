import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { SpeakInput, VoiceEvent } from "../../main/voice/protocol";
import type { ConversationTurnInput, TurnIdentity } from "../../shared/contracts";
import { createHandsFreeVoiceController } from "./hands-free";
import type {
	HandsFreeAudioFactory,
	HandsFreeOptions,
	HandsFreeVoiceController,
} from "./hands-free-types";

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
function harness(extra: Partial<HandsFreeOptions> = {}) {
	let now = 0;
	let ids = 0;
	const sessions: {
		observer: Parameters<HandsFreeAudioFactory>[0];
		closed: boolean;
		opens: number;
	}[] = [];
	const turns: {
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
	const events = new Map<string, VoiceEvent[]>();
	let open = async () => {};
	let cancellation = async () => {};
	let delayConnect = false;
	let autoDrain = true;
	let finishSpeech = true;
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
			createTurn: () => {
				const turn = {
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
	const voice = createHandsFreeVoiceController({
		sessionId: "shared-conversation",
		id: () => `id-${++ids}`,
		now: () => now,
		pollIntervalMs: 10,
		getConversationContext: () => ({}),
		audio,
		onError: (error) => {
			errors.push(error);
		},
		voice: {
			offer: async () => ({ type: "answer", sdp: "synthetic" }),
			release: async (input) => {
				releases.push(input);
				emit(input, { kind: "transcript", text: "Hello", final: true });
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
	});
	owned.push(voice);
	return {
		voice,
		sessions,
		turns,
		starts,
		releases,
		speaks,
		cancels,
		errors,
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
