import assert from "node:assert/strict";
import { it } from "node:test";
import superjson from "superjson";
import type { VoiceEvent } from "../../main/voice/protocol";
import {
	type ConversationTurnInput,
	ConversationTurnInputSchema,
	TurnIdentitySchema,
} from "../../shared/contracts";
import { createConversationApi } from "./api";
import { createConversationController } from "./controller";
import { connectConversationVoice } from "./voice";
async function until(condition: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "Timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
it("keeps actual speech draining through manual file changes and shares identity with typed follow-up", async () => {
	const paths: string[] = [];
	const checkpoints: string[] = [];
	const starts: ConversationTurnInput[] = [];
	const events: VoiceEvent[] = [];
	const spoken: string[] = [];
	const api = createConversationApi(async (request) => {
		paths.push(request.path);
		const input = superjson.deserialize<Record<string, unknown>>(request.input);
		let value: unknown;
		if (request.path === "app.config")
			value = {
				envPath: "/local/.env",
				configured: { meta: true, elevenlabs: true, github: false },
				voiceId: "voice",
				microphone: "granted",
			};
		if (request.path === "voice.status") value = { phase: "ready", voiceId: "voice", missing: [] };
		if (request.path === "voice.offer") value = { type: "answer", sdp: "test-answer" };
		if (request.path === "voice.release") {
			const identity = TurnIdentitySchema.parse(input);
			for (let i = 0; i < 2; i++)
				events.push({
					...identity,
					sequence: events.length + 1,
					kind: "transcript",
					final: true,
					text: "Hello from speech",
				});
		}
		if (request.path === "voice.speak") {
			spoken.push(String(input["text"]));
			events.push({
				sessionId: String(input["sessionId"]),
				turnId: String(input["turnId"]),
				generation: Number(input["generation"]),
				sequence: events.length + 1,
				kind: "speech-ended",
				speechId: String(input["speechId"]),
			});
		}
		if (request.path === "voice.poll")
			value = { events: events.filter((event) => event.sequence > Number(input["afterSequence"])) };
		if (request.path === "conversation.start") {
			const turn = ConversationTurnInputSchema.parse(input);
			starts.push(turn);
			value = {
				sessionId: turn.sessionId,
				turnId: turn.turnId,
				generation: turn.generation,
				status: "running",
			};
		}
		if (request.path === "conversation.narrationApplied") {
			checkpoints.push(String(input["status"]));
			value = { status: "accepted" };
		}
		if (request.path === "conversation.poll") {
			const turn = starts.at(-1);
			assert.ok(turn);
			const identity = {
				sessionId: turn.sessionId,
				turnId: turn.turnId,
				generation: turn.generation,
			};
			value = {
				...identity,
				status: "completed",
				sequence: 3,
				text: "Provider reply.",
				actions: [],
				events: [
					{ ...identity, sequence: 1, kind: "text-delta", delta: "Provider reply." },
					{
						...identity,
						sequence: 2,
						kind: "action",
						action: {
							...identity,
							kind: "narration-checkpoint",
							requestId: "proof",
							screenSequence: 0,
							throughTextLength: "Provider reply.".length,
						},
					},
					{ ...identity, sequence: 3, kind: "completed" },
				],
			};
		}
		if (request.path === "conversation.cancel")
			value = {
				sessionId: input["sessionId"],
				turnId: input["turnId"],
				generation: input["generation"],
				requestId: input["requestId"],
				status: "cancelled",
			};
		return { result: { data: superjson.serialize(value) } };
	});
	let draining = false;
	let releaseDrain!: () => void;
	const drained = new Promise<void>((resolve) => {
		releaseDrain = resolve;
	});
	let closed = false;
	const ui = createConversationController(api);
	const disconnect = connectConversationVoice(api, ui, () => ({
		connect: async (offer) => {
			await offer({ type: "offer", sdp: "test-offer" });
		},
		stopCapture() {},
		drain: async () => {
			draining = true;
			await drained;
		},
		close() {
			closed = true;
		},
	}));
	try {
		await ui.configure();
		ui.press();
		await until(() => ui.store.getState().phase === "listening");
		ui.release();
		await until(() => draining);
		const active = ui.store.getState().active;
		ui.manualChange();
		await ui.selectPR(null);
		assert.deepEqual(ui.store.getState().active, active);
		assert.equal(closed, false);
		assert.equal(paths.includes("voice.cancel"), false);
		assert.equal(paths.includes("conversation.cancel"), false);
		releaseDrain();
		await until(() => ui.store.getState().exchanges[0]?.phase === "complete");
		assert.deepEqual(checkpoints, ["ignored"]);
		assert.equal(starts.length, 1);
		assert.equal(ui.store.getState().exchanges[0]?.requestId, starts[0]?.requestId);
		assert.equal(starts[0]?.prId, undefined);
		assert.equal("screenContext" in (starts[0] ?? {}), false);
		assert.equal(ui.store.getState().exchanges[0]?.question, "Hello from speech");
		assert.equal(ui.store.getState().exchanges[0]?.answer, "Provider reply.");
		assert.deepEqual(spoken, ["Provider reply."], "Speak only the actual answer, without filler");
		await ui.submit("Typed follow-up");
		assert.equal(starts.length, 2);
		assert.equal(starts[0]?.sessionId, starts[1]?.sessionId);
		assert.ok(Number(starts[1]?.generation) > Number(starts[0]?.generation));
		assert.equal(
			paths.some((path) => /^(agent|screen|bootstrap)\./.test(path)),
			false
		);
	} finally {
		ui.dispose();
		disconnect();
	}
});

it("claimed initiative traverses the actual hands-free adapter without fake speech, settles after PCM drain, and barge-in keeps listening", async () => {
	const { createAttentionBinding } = await import("./attention");
	const turnIdentity = (input: Record<string, unknown>) =>
		TurnIdentitySchema.parse({
			sessionId: input["sessionId"],
			turnId: input["turnId"],
			generation: input["generation"],
		});
	const calls: Array<{ path: string; input: Record<string, unknown> }> = [];
	const events = new Map<string, VoiceEvent[]>();
	const media = new Map<
		string,
		{
			observer: Parameters<import("../voice").MediaFactory>[0];
			samples: Float32Array[];
			closed: boolean;
		}
	>();
	let frame: ((value: import("../voice/activity").SpeechFrame) => void) | undefined;
	let physicalClosed = false;
	let physicalOpens = 0;
	let claimCount = 0;
	let releaseDrain!: () => void;
	let draining = false;
	let holdDrain = true;
	const heldDrain = new Promise<void>((resolve) => {
		releaseDrain = resolve;
	});
	let currentMedia:
		| {
				observer: Parameters<import("../voice").MediaFactory>[0];
				samples: Float32Array[];
				closed: boolean;
		  }
		| undefined;
	const emit = (
		input: Record<string, unknown>,
		event:
			| { kind: "speech-ended"; speechId: string }
			| { kind: "transcript"; text: string; final: boolean }
	) => {
		const turn = turnIdentity(input);
		const list = events.get(turn.turnId) ?? [];
		list.push({ ...turn, sequence: list.length + 1, ...event });
		events.set(turn.turnId, list);
	};
	const api = createConversationApi(async (request) => {
		const input = request.input
			? superjson.deserialize<Record<string, unknown>>(request.input)
			: {};
		calls.push({ path: request.path, input });
		let value: unknown;
		if (request.path === "app.config")
			value = {
				envPath: "/test/.env",
				configured: { meta: true, elevenlabs: true, github: false },
				voiceId: "voice",
				microphone: "granted",
			};
		if (request.path === "voice.status") value = { phase: "ready", voiceId: "voice", missing: [] };
		if (request.path === "attention.poll")
			value = {
				claim: {
					id: `claim-${++claimCount}`,
					sessionId: input["sessionId"],
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
					items: [
						{
							noticeId: "notice",
							kind: "work-ready",
							jobId: "job",
							repository: "owner/repo",
							label: "Work ready",
							headSha: null,
							decisionId: null,
							question: null,
							changedFileCount: 1,
							applied: false,
						},
					],
				},
			};
		if (request.path === "voice.offer") {
			assert.ok(currentMedia);
			media.set(String(input["turnId"]), currentMedia);
			value = { type: "answer", sdp: "controlled" };
		}
		if (request.path === "conversation.attend" || request.path === "conversation.start")
			value = { ...turnIdentity(input), status: "running" };
		if (request.path === "conversation.poll")
			value = {
				...turnIdentity(input),
				status: "completed",
				sequence: 1,
				text: "The actual work is ready.",
				actions: [],
				events: [],
			};
		if (request.path === "voice.speak") {
			media.get(String(input["turnId"]))?.observer.pcm({
				rms: 0.1,
				observedAt: performance.now(),
				basis: "webaudio-output-analyser",
			});
			emit(input, { kind: "speech-ended", speechId: String(input["speechId"]) });
		}
		if (request.path === "voice.poll")
			value = {
				events: (events.get(String(input["turnId"])) ?? []).filter(
					(event) => event.sequence > Number(input["afterSequence"])
				),
			};
		if (request.path === "voice.release")
			emit(input, { kind: "transcript", text: "My actual utterance", final: true });
		if (request.path === "conversation.cancel")
			value = {
				...turnIdentity(input),
				requestId: input["requestId"],
				status: "cancelled",
			};
		if (request.path === "attention.settle" || request.path === "attention.release")
			value = { status: "accepted" };
		return { result: { data: superjson.serialize(value) } };
	});
	const ui = createConversationController(api);
	const disconnect = connectConversationVoice(api, ui, undefined, (observer) => {
		frame = observer.frame;
		return {
			start: async () => {
				physicalOpens++;
			},
			close: () => {
				physicalClosed = true;
			},
			createTurn: (output) => {
				const turn = { observer: output, samples: [] as Float32Array[], closed: false };
				currentMedia = turn;
				return {
					connect: async (offer) => {
						await offer({ type: "offer", sdp: "controlled" });
					},
					append: (samples) => {
						turn.samples.push(samples.slice());
					},
					finishInput: async () => {},
					stopCapture: () => {},
					drain: async () => {
						if (holdDrain) {
							draining = true;
							await heldDrain;
						}
					},
					close: () => {
						turn.closed = true;
					},
				};
			},
		};
	});
	const binding = createAttentionBinding(api, ui, {
		getSnapshot: () => ({
			enabled: true,
			focused: true,
			obscured: false,
			typing: false,
			recentInteraction: false,
			activitySequence: 0,
		}),
		subscribe: () => () => {},
	});
	const feed = (tone = false, count = 1) => {
		assert.ok(frame);
		for (let n = 0; n < count; n++)
			frame({
				samples: Float32Array.from({ length: 960 }, (_, i) =>
					tone ? Math.sin((i * 2 * Math.PI * 523) / 48000) * 0.1 : 0
				),
				reference: new Float32Array(960),
				sampleRate: 48000,
			});
	};
	try {
		await ui.configure();
		await ui.startConversation();
		feed();
		await binding.poll();
		await until(() => draining);
		assert.deepEqual(ui.store.getState().exchanges, []);
		assert.equal(calls.filter((call) => call.path === "conversation.attend").length, 1);
		assert.equal(
			calls.filter(
				(call) =>
					call.path === "conversation.start" ||
					call.path === "voice.release" ||
					call.path === "attention.settle"
			).length,
			0
		);
		const attend = calls.find((call) => call.path === "conversation.attend");
		assert.deepEqual(Object.keys(attend?.input ?? {}).sort(), [
			"claimId",
			"generation",
			"requestId",
			"sessionId",
			"turnId",
		]);
		assert.equal(
			calls.some(
				(call) => call.path === "diagnostics.record" && call.input["stage"] === "speech-start"
			),
			false
		);
		releaseDrain();
		await until(() => calls.some((call) => call.path === "attention.settle"));
		assert.equal(calls.find((call) => call.path === "attention.settle")?.input["status"], "spoken");
		holdDrain = false;
		await new Promise((resolve) => setTimeout(resolve, 5));
		// The next reply is interrupted during its actual model start, before any user transcript exists.
		const delayed = new Promise<unknown>(() => {});
		const call = api.call;
		api.call = (type, path, input) =>
			path === "conversation.attend" ? delayed : call(type, path, input);
		await binding.poll();
		await until(() => ui.store.getState().attention !== null);
		const old = ui.store.getState().active;
		assert.ok(old);
		feed(true, 15);
		await until(() => calls.filter((entry) => entry.path === "attention.settle").length === 2);
		assert.equal(
			calls.filter((entry) => entry.path === "attention.settle")[1]?.input["status"],
			"interrupted"
		);
		assert.equal(physicalClosed, false);
		assert.equal(physicalOpens, 1);
		assert.equal(media.get(old.turnId)?.closed, true);
		feed(false, 35);
		await until(() => ui.store.getState().exchanges[0]?.question === "My actual utterance");
		assert.equal(calls.filter((entry) => entry.path === "conversation.start").length, 1);
		assert.equal(ui.store.getState().handsFree, true);
		assert.equal(ui.store.getState().exchanges[0]?.source, "voice");
	} finally {
		binding.dispose();
		ui.dispose();
		disconnect();
	}
});
