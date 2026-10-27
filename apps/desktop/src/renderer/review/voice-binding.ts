import { create } from "zustand";
import {
	SpeakSchema,
	VoiceAnswerSchema,
	VoiceOfferSchema,
	VoicePollResultSchema,
	VoicePollSchema,
} from "../../main/voice/protocol";
import {
	AgentTurnInputSchema,
	AgentTurnStatusSchema,
	CancelTurnInputSchema,
	CancelTurnResultSchema,
	PollTurnResultSchema,
	PollTurnSchema,
	TurnIdentitySchema,
	VoiceSetupInputSchema,
	type VoiceSetupStatus,
	VoiceSetupStatusSchema,
} from "../../shared/contracts";
import { type MediaFactory, createBrowserMediaFactory, createVoiceController } from "../voice";
import { type ReviewRequest, createReviewRpc } from "./composition-bridge";
import { getScreenContext, useReview } from "./controller";
import { allocateReviewTurn, externalVoiceTurn, reviewSessionId } from "./conversation";
import { reviewErrorMessage } from "./errors";
import { type VoiceAdapter, type VoiceSetupAdapter, configureReviewServices } from "./services";

export const useVoiceReadiness = create<{ status: VoiceSetupStatus | null }>(() => ({
	status: null,
}));
const StartResult = TurnIdentitySchema.extend({ status: AgentTurnStatusSchema });

/** Voice owns start/poll/audio; these hooks only display that same turn in the review. */
export function connectReviewVoice(
	request: ReviewRequest,
	media: MediaFactory = createBrowserMediaFactory()
) {
	const rpc = createReviewRpc(request);
	let disposed = false;
	let setupEpoch = 0;
	let changingSetup = false;
	let requiresPreparation = false;
	const listeners = new Set<() => void>();
	const call = (signal: AbortSignal, type: "query" | "mutation", path: string, input: unknown) => {
		signal.throwIfAborted();
		// Controller bounds transport waits and compensates late allocations with cancellation RPCs.
		return rpc(type, path, input);
	};
	const controller = createVoiceController({
		sessionId: reviewSessionId,
		allocateIdentity: allocateReviewTurn,
		media,
		getScreenContext,
		getKeywords: () =>
			useReview
				.getState()
				.files.map((file) => file.path)
				.slice(0, 100)
				.filter((path) => path.length <= 100),
		acknowledgementText: "I’m checking that.",
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
		agent: {
			start: async (input, signal) => {
				await call(signal, "mutation", "screen.update", {
					sessionId: input.sessionId,
					screenContext: input.screenContext,
				});
				return StartResult.parse(
					await call(signal, "mutation", "agent.start", AgentTurnInputSchema.parse(input))
				);
			},
			poll: async (input, signal) =>
				PollTurnResultSchema.parse(
					await call(signal, "query", "agent.poll", PollTurnSchema.parse(input))
				),
			cancel: async (input, signal) =>
				CancelTurnResultSchema.parse(
					await call(signal, "mutation", "agent.cancel", CancelTurnInputSchema.parse(input))
				),
		},
		onTurnStart: (identity) => {
			if (!externalVoiceTurn.begin(identity)) throw new Error("Voice identity is stale");
		},
		onTranscript: (update) => externalVoiceTurn.transcript(update, update.text),
		onAnswer: (text, identity) => externalVoiceTurn.replaceText(identity, text),
		onAction: async (action, _screen, signal) => {
			if (!signal.aborted) await externalVoiceTurn.action(action);
		},
		onTurnEnd: (identity, result) =>
			externalVoiceTurn.finish(
				identity,
				result.status === "completed"
					? "complete"
					: result.status === "cancelled"
						? "cancelled"
						: "error",
				result.status === "failed" ? reviewErrorMessage(result.error) : ""
			),
		onError: (error) => useReview.getState().announce(reviewErrorMessage(error)),
	});
	const publish = (status: VoiceSetupStatus) => {
		if (disposed) return status;
		useVoiceReadiness.setState({ status });
		for (const listener of listeners) listener();
		return status;
	};
	const clearReadiness = () => {
		if (disposed) return;
		useVoiceReadiness.setState({ status: null });
		for (const listener of listeners) listener();
	};
	const invalidate = () => {
		setupEpoch++;
		requiresPreparation = true;
		controller.interrupt("user");
		clearReadiness();
	};
	const setup: VoiceSetupAdapter = {
		invalidate,
		status: async () => {
			const epoch = setupEpoch;
			try {
				const status = VoiceSetupStatusSchema.parse(await rpc("query", "voice.status"));
				if (epoch === setupEpoch && !changingSetup)
					publish(
						requiresPreparation && status.phase === "ready"
							? { ...status, phase: "stopped" }
							: status
					);
				return status;
			} catch (error) {
				if (epoch === setupEpoch) clearReadiness();
				throw error;
			}
		},
		configure: async (voiceId) => {
			invalidate();
			const epoch = setupEpoch;
			changingSetup = true;
			try {
				const status = VoiceSetupStatusSchema.parse(
					await rpc("mutation", "voice.configure", VoiceSetupInputSchema.parse({ voiceId }))
				);
				if (epoch === setupEpoch)
					publish(status.phase === "ready" ? { ...status, phase: "stopped" } : status);
				return status;
			} finally {
				if (epoch === setupEpoch) changingSetup = false;
			}
		},
		prepare: async () => {
			invalidate();
			const epoch = setupEpoch;
			changingSetup = true;
			try {
				const status = VoiceSetupStatusSchema.parse(await rpc("mutation", "voice.prepare"));
				if (epoch === setupEpoch) {
					requiresPreparation = false;
					publish(status);
				}
				return status;
			} finally {
				if (epoch === setupEpoch) changingSetup = false;
			}
		},
	};
	const voice: VoiceAdapter = {
		beginCapture: () => {
			if (useReview.getState().sourceMode !== "repository") {
				useReview.getState().announce("Load a review before asking a voice question.");
				return;
			}
			if (useVoiceReadiness.getState().status?.phase !== "ready") {
				useReview.getState().announce("Prepare voice in Settings, then wait until it is ready.");
				return;
			}
			controller.beginCapture();
		},
		endCapture: () => controller.endCapture(),
		interrupt: (reason) => controller.interrupt(reason),
		getPhase: () =>
			controller.connecting
				? "connecting"
				: controller.getPhase() !== "idle"
					? controller.getPhase()
					: useVoiceReadiness.getState().status?.phase === "ready"
						? "idle"
						: useVoiceReadiness.getState().status?.phase === "preparing"
							? "preparing voice"
							: "voice setup needed",
		subscribe: (listener) => {
			listeners.add(listener);
			const unsubscribe = controller.subscribe(listener);
			return () => {
				listeners.delete(listener);
				unsubscribe();
			};
		},
	};
	configureReviewServices({ voice, voiceSetup: setup });
	let timer: ReturnType<typeof setTimeout>;
	const refresh = async () => {
		try {
			await setup.status();
		} catch {
			/* Missing setup routes leave capture unavailable. */
		}
		if (!disposed) timer = setTimeout(() => void refresh(), 2000);
	};
	void refresh();
	return () => {
		disposed = true;
		clearTimeout(timer);
		controller.dispose();
		listeners.clear();
		configureReviewServices({ voice: null, voiceSetup: null });
		useVoiceReadiness.setState({ status: null });
	};
}
