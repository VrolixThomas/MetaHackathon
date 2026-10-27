import {
	SpeakSchema,
	VoiceAnswerSchema,
	VoiceOfferSchema,
	VoicePollResultSchema,
	VoicePollSchema,
} from "../../main/voice/protocol";
import { ConversationTurnInputSchema, TurnIdentitySchema } from "../../shared/contracts";
import { type MediaFactory, createBrowserMediaFactory, createVoiceController } from "../voice";
import type { ConversationApi } from "./api";
import type { ConversationController } from "./controller";
import { conversationErrorMessage } from "./errors";

/** V1 uses conversation RPCs and an optional PR; it never creates review/screen context. */
export function connectConversationVoice(
	api: ConversationApi,
	ui: ConversationController,
	media: MediaFactory = createBrowserMediaFactory()
) {
	const call = (signal: AbortSignal, type: "query" | "mutation", path: string, input: unknown) => {
		signal.throwIfAborted();
		return api.call(type, path, input);
	};
	const voice = createVoiceController({
		sessionId: ui.sessionId,
		allocateIdentity: ui.allocateIdentity,
		getConversationContext: ui.getConversationContext,
		acknowledgementText: "One moment.",
		media,
		agent: {
			start: (input, signal) => {
				signal.throwIfAborted();
				return api.start(ConversationTurnInputSchema.parse(input));
			},
			poll: (input, signal) => {
				signal.throwIfAborted();
				return api.poll(input);
			},
			cancel: (input, signal) => {
				signal.throwIfAborted();
				return api.cancel(input);
			},
		},
		voice: {
			offer: async (input, signal) =>
				VoiceAnswerSchema.parse(
					await call(signal, "mutation", "voice.offer", VoiceOfferSchema.parse(input))
				),
			release: async (input, signal) => {
				await call(signal, "mutation", "voice.release", TurnIdentitySchema.parse(input));
			},
			speak: async (input, signal) => {
				await call(signal, "mutation", "voice.speak", SpeakSchema.parse(input));
			},
			cancel: async (input, signal) => {
				await call(signal, "mutation", "voice.cancel", TurnIdentitySchema.parse(input));
			},
			poll: async (input, signal) =>
				VoicePollResultSchema.parse(
					await call(signal, "query", "voice.poll", VoicePollSchema.parse(input))
				),
		},
		onTurnStart: (turn) => {
			if (!ui.beginVoice(turn)) throw new Error("Stale conversation identity");
		},
		onTranscript: (update) => ui.transcript(update, update.text),
		onAnswer: (text, turn) => ui.answer(turn, text),
		onTurnEnd: (turn, result) =>
			ui.finishVoice(
				turn,
				result.status === "completed"
					? "complete"
					: result.status === "cancelled"
						? "cancelled"
						: "error",
				result.status === "failed"
					? conversationErrorMessage(result.error, ui.store.getState().config?.microphone)
					: ""
			),
		onError: (error) => ui.voiceError(error),
	});
	ui.attachVoice(voice);
	const unsubscribe = voice.subscribe(() =>
		ui.voicePhase(
			voice.connecting ? "connecting" : voice.getPhase() === "idle" ? "idle" : voice.getPhase()
		)
	);
	return () => {
		unsubscribe();
		voice.dispose();
	};
}
