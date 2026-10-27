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
it("speaks without a PR, starts once per final utterance and shares identity with typed follow-up", async () => {
	const paths: string[] = [];
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
				sequence: 2,
				text: "Provider reply.",
				actions: [],
				events: [
					{ ...identity, sequence: 1, kind: "text-delta", delta: "Provider reply." },
					{ ...identity, sequence: 2, kind: "completed" },
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
	const ui = createConversationController(api);
	const disconnect = connectConversationVoice(api, ui, () => ({
		connect: async (offer) => {
			await offer({ type: "offer", sdp: "test-offer" });
		},
		stopCapture() {},
		drain: async () => {},
		close() {},
	}));
	try {
		await ui.configure();
		ui.press();
		await until(() => ui.store.getState().phase === "listening");
		ui.release();
		await until(() => ui.store.getState().exchanges[0]?.phase === "complete");
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
