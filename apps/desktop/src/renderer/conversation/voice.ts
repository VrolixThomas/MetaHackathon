import {
	SpeakSchema,
	VoiceAnswerSchema,
	VoiceOfferSchema,
	VoicePollResultSchema,
	VoicePollSchema,
} from "../../main/voice/protocol";
import {
	type ConversationDiagnostic,
	ConversationTurnInputSchema,
	type TurnIdentity,
	TurnIdentitySchema,
	VoiceDiagnosticSchema,
} from "../../shared/contracts";
import {
	type MediaFactory,
	type VoiceControllerOptions,
	createHandsFreeVoiceController,
	createVoiceController,
} from "../voice";
import type { ConversationApi } from "./api";
import type { ConversationController } from "./controller";
import { conversationErrorMessage } from "./errors";

/** V1 uses conversation RPCs and an optional PR; it never creates review/screen context. */
export function connectConversationVoice(
	api: ConversationApi,
	ui: ConversationController,
	media?: MediaFactory
) {
	const onlyTurn = ({ sessionId, turnId, generation }: TurnIdentity): TurnIdentity => ({
		sessionId,
		turnId,
		generation,
	});
	const starts = new Map<string, { at: number; stages: Set<string> }>();
	let lastTurn: TurnIdentity | undefined;
	const trace = (
		stage: ConversationDiagnostic["stage"],
		turn?: TurnIdentity,
		extra: Partial<ConversationDiagnostic> = {}
	) => {
		const key = turn ? JSON.stringify(turn) : "";
		const timing = starts.get(key);
		if (timing?.stages.has(stage)) return;
		timing?.stages.add(stage);
		void api
			.call("mutation", "diagnostics.record", {
				stage,
				...(turn ? { turn } : {}),
				...(timing ? { elapsedMs: Math.max(0, Math.round(performance.now() - timing.at)) } : {}),
				...extra,
			})
			.catch(() => {});
	};
	const call = (signal: AbortSignal, type: "query" | "mutation", path: string, input: unknown) => {
		signal.throwIfAborted();
		return api.call(type, path, input);
	};
	const options: Omit<VoiceControllerOptions, "media"> = {
		sessionId: ui.sessionId,
		allocateIdentity: ui.allocateIdentity,
		getConversationContext: ui.getConversationContext,
		agent: {
			start: (input, signal) => {
				signal.throwIfAborted();
				const turn = ConversationTurnInputSchema.parse(input);
				ui.requestStarted(turn);
				trace("agent-start", onlyTurn(turn));
				return api.start(turn);
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
			lastTurn = turn;
			starts.set(JSON.stringify(turn), { at: performance.now(), stages: new Set() });
			if (starts.size > 128) {
				const first = starts.keys().next().value;
				if (first) starts.delete(first);
			}
			trace("speech-start", turn);
		},
		onConversationAction: async (action, signal) => {
			await ui.applyConversationAction(action, signal);
		},
		onTranscript: (update) => {
			if (update.final) trace("transcript-final", onlyTurn(update));
			ui.transcript(update, update.text);
		},
		onAnswer: (text, turn) => {
			if (text.trim()) trace("first-answer", turn);
			ui.answer(turn, text);
		},
		onLatency: (value) => {
			if (value.kind === "answer")
				trace("first-audio", onlyTurn(value), {
					releaseToAudioMs: value.elapsedMs,
				});
		},
		onTurnEnd: (turn, result) => {
			const recoverable =
				result.status === "failed" && "recoverable" in result && result.recoverable === true;
			trace(
				result.status === "completed"
					? "turn-completed"
					: result.status === "cancelled"
						? "turn-cancelled"
						: "turn-failed",
				turn,
				result.status === "failed"
					? { failureSource: "origin" in result && result.origin === "agent" ? "agent" : "voice" }
					: {}
			);
			ui.finishVoice(
				turn,
				result.status === "completed"
					? "complete"
					: result.status === "cancelled"
						? "cancelled"
						: "error",
				result.status === "failed"
					? conversationErrorMessage(result.error, ui.store.getState().config?.microphone)
					: "",
				recoverable
			);
		},
		onError: (error) => {
			const diagnostic = VoiceDiagnosticSchema.safeParse(
				"diagnostic" in error ? error.diagnostic : undefined
			);
			trace("turn-failed", undefined, diagnostic.success ? { diagnostic: diagnostic.data } : {});
			ui.voiceError(error);
		},
	};
	// Explicit injected media retains the deterministic single-utterance test/legacy adapter.
	if (media) {
		const voice = createVoiceController({ ...options, media });
		ui.attachVoice(voice);
		const unsubscribe = voice.subscribe(() =>
			ui.voicePhase(voice.connecting ? "connecting" : voice.getPhase())
		);
		return () => {
			unsubscribe();
			voice.dispose();
		};
	}
	const conversation = createHandsFreeVoiceController(options);
	ui.attachVoice({
		beginCapture: () => {
			void ui.startConversation();
		},
		endCapture: () => ui.endConversation(),
		interrupt: (reason) => conversation.interrupt(reason),
		dispose: () => conversation.dispose(),
	});
	ui.attachHandsFree({
		start: () => conversation.startListening(),
		stop: () => conversation.stopListening(),
		interrupt: () => conversation.interrupt(),
	});
	const unsubscribe = conversation.subscribe(() => {
		const session = conversation.getSessionSnapshot();
		if (session.phase === "responding" && lastTurn) trace("speech-ended", lastTurn);
		const phase = conversation.getPhase();
		ui.voicePhase(
			session.phase === "capturing" && phase === "idle"
				? "connecting"
				: session.phase === "responding" && (phase === "idle" || phase === "listening")
					? "transcribing"
					: phase
		);
		const state = ui.store.getState();
		if (
			(state.handsFree || state.handsFreeStarting) &&
			(session.phase === "stopped" || session.phase === "error")
		)
			ui.handsFreeStopped(session.phase === "error" ? session.error : undefined);
	});
	return () => {
		unsubscribe();
		ui.attachHandsFree(null);
		conversation.dispose();
	};
}
