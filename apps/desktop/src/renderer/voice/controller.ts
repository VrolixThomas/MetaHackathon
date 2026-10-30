import { VoiceDiagnosticError } from "../../main/voice/diagnostics";
import {
	SpeakSchema,
	VoiceAnswerSchema,
	type VoiceEvent,
	VoiceOfferSchema,
	VoicePollResultSchema,
	VoicePollSchema,
} from "../../main/voice/protocol";
import {
	type AgentAction,
	type AgentEvent,
	type AgentTurnInput,
	AgentTurnInputSchema,
	AgentTurnStatusSchema,
	type CancelTurnInput,
	CancelTurnInputSchema,
	CancelTurnResultSchema,
	ConversationAttentionInputSchema,
	type ConversationTurnInput,
	ConversationTurnInputSchema,
	IdSchema,
	PollTurnResultSchema,
	PollTurnSchema,
	ScreenContextSchema,
	type TurnIdentity,
	TurnIdentitySchema,
	type VoiceState,
	VoiceStateSchema,
} from "../../shared/contracts";
import { asError, bounded, delay } from "./async";
import { VoiceFailure, fromOrigin, reportTurnFailure } from "./failure";
import { Sentences } from "./sentences";
import type {
	PcmObservation,
	VoiceController,
	VoiceControllerOptions,
	VoiceMedia,
	VoiceTurnEnd,
} from "./types";

const StartResultSchema = TurnIdentitySchema.extend({ status: AgentTurnStatusSchema });
const MAX_TEXT = 32_000;
const MAX_ACTIONS = 256;
const MAX_QUEUE = 128;
type Speech = { id: string; text: string; kind: "acknowledgement" | "answer"; observed: boolean };
type Turn = {
	claimId: string | null;
	identity: TurnIdentity;
	keywords: string[];
	abort: AbortController;
	media: VoiceMedia | null;
	deadline: ReturnType<typeof setTimeout> | null;
	ready: boolean;
	releasedAt: number | null;
	finalized: boolean;
	finalText: string | null;
	voiceSequence: number;
	agentSequence: number;
	prId: string | null;
	actions: Set<string>;
	text: string;
	sentences: Sentences;
	queue: Speech[];
	speech: Speech | null;
	ended: (() => void) | null;
	measured: Set<Speech["kind"]>;
	agentDone: boolean;
	speaking: boolean;
	pump: Promise<void> | null;
	hasAnswer: boolean;
	failure: Error | null;
};

export function sameTurn(left: TurnIdentity, right: TurnIdentity): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.turnId === right.turnId &&
		left.generation === right.generation
	);
}

export function createVoiceController(options: VoiceControllerOptions): VoiceController {
	const now = options.now ?? (() => performance.now());
	const id = options.id ?? (() => crypto.randomUUID());
	if (options.allocateIdentity && options.sessionId === undefined)
		throw new Error("Shared voice identity allocation requires the review session ID");
	const sessionId = TurnIdentitySchema.shape.sessionId.parse(options.sessionId ?? id());
	const ack =
		options.acknowledgementText === undefined
			? null
			: SpeakSchema.shape.text.parse(options.acknowledgementText.trim());
	const completion =
		options.completionText === undefined
			? null
			: SpeakSchema.shape.text.parse(options.completionText.trim());
	const pollInterval = Math.max(10, options.pollIntervalMs ?? 50);
	const rpcTimeout = Math.max(100, options.rpcTimeoutMs ?? 15_000);
	const mediaSetupTimeout = Math.max(100, options.mediaSetupTimeoutMs ?? 90_000);
	const speechTimeout = Math.max(100, options.speechTimeoutMs ?? 45_000);
	const turnTimeout = Math.max(100, options.turnTimeoutMs ?? 180_000);
	const listeners = new Set<() => void>();
	let generation = 0;
	let captureSequence = 0;
	let active: Turn | null = null;
	let disposed = false;
	let state: Readonly<VoiceState> = Object.freeze(
		VoiceStateSchema.parse({
			sessionId,
			turnId: null,
			generation,
			phase: "idle",
			transcript: "",
			transcriptFinal: false,
		})
	);
	const live = (turn: Turn) => !disposed && active === turn && !turn.abort.signal.aborted;
	const report = (error: unknown) => {
		try {
			options.onError?.(asError(error));
		} catch {
			/* Reporting cannot prevent cleanup. */
		}
	};
	const publish = (patch: Partial<VoiceState>) => {
		state = Object.freeze(VoiceStateSchema.parse({ ...state, ...patch }));
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch (error) {
				report(error);
			}
		}
	};
	const rpc = <T>(turn: Turn, work: Promise<T>) => bounded(work, turn.abort.signal, rpcTimeout);
	const reportCleanup = (turn: Turn, error: unknown) => {
		if (
			turn.failure ||
			disposed ||
			state.turnId !== turn.identity.turnId ||
			state.generation !== turn.identity.generation
		)
			return;
		turn.failure = asError(error);
		report(turn.failure);
	};

	// Cancellation has its own signal: aborting the capture transport must not abort the cancel RPC.
	function cancelRemote(turn: Turn, reason: CancelTurnInput["reason"], target?: "voice" | "agent") {
		for (const name of target ? [target] : (["voice", "agent"] as const)) {
			const signal = AbortSignal.timeout(rpcTimeout);
			try {
				if (name === "voice") {
					void bounded(
						options.voice.cancel(TurnIdentitySchema.parse(turn.identity), signal),
						signal,
						rpcTimeout
					).catch((error) => reportCleanup(turn, error));
					continue;
				}
				const input = CancelTurnInputSchema.parse({ ...turn.identity, requestId: id(), reason });
				void bounded(options.agent.cancel(input, signal), signal, rpcTimeout)
					.then((result) => {
						const parsed = CancelTurnResultSchema.parse(result);
						if (!sameTurn(parsed, input) || parsed.requestId !== input.requestId)
							throw new Error("Mismatched cancellation result");
					})
					.catch((error) => reportCleanup(turn, error));
			} catch (error) {
				reportCleanup(turn, error);
			}
		}
	}

	function detach(turn: Turn) {
		// Invalidate before abort listeners, media callbacks or asynchronous cleanup can run.
		if (active === turn) active = null;
		turn.abort.abort();
		if (turn.deadline !== null) clearTimeout(turn.deadline);
		turn.deadline = null;
		turn.queue.length = 0;
		turn.ended = null;
		try {
			turn.media?.close();
		} catch (error) {
			reportCleanup(turn, error);
		}
	}

	function stop(
		reason: CancelTurnInput["reason"],
		error?: Error,
		origin: Extract<VoiceTurnEnd, { status: "failed" }>["origin"] = "controller"
	) {
		const turn = active;
		if (!turn) return;
		if (error) turn.failure ??= error;
		const recoverable = origin === "agent" || turn.claimId !== null;
		detach(turn);
		cancelRemote(turn, reason);
		publish({
			phase: error ? "error" : "cancelled",
			...(error ? { error: error.message || "Voice failed" } : {}),
		});
		end(
			turn,
			error
				? {
						status: "failed",
						error: error.message || "Voice failed",
						origin,
						recoverable,
					}
				: {
						status: "cancelled",
						reason,
					}
		);
		if (error)
			reportTurnFailure(error, { ...turn.identity, origin, recoverable }, () => report(error));
	}
	function end(turn: Turn, result: VoiceTurnEnd) {
		try {
			options.onTurnEnd?.({ ...turn.identity }, result);
		} catch (error) {
			const failure = asError(error);
			reportTurnFailure(
				failure,
				{ ...turn.identity, origin: "controller", recoverable: false },
				() => report(failure)
			);
		}
	}
	function fail(
		turn: Turn,
		error: unknown,
		origin: Extract<VoiceTurnEnd, { status: "failed" }>["origin"] = "controller"
	) {
		if (live(turn))
			stop(
				"user",
				error instanceof VoiceFailure ? error.error : asError(error),
				error instanceof VoiceFailure ? error.origin : origin
			);
	}
	function finish(turn: Turn) {
		if (!live(turn) || !turn.agentDone || turn.speaking || turn.queue.length) return;
		if (turn.claimId && !turn.hasAnswer) {
			fail(turn, new VoiceFailure("agent", new Error("Attention produced no spoken answer")));
			return;
		}
		detach(turn);
		// Explicitly release main/sidecar state as well as the browser peer.
		cancelRemote(turn, "user");
		publish({ phase: "idle" });
		end(turn, { status: "completed" });
	}

	/** If cancel beats an in-flight server allocation, cancel again when it settles. */
	function allocation<T>(
		turn: Turn,
		target: "voice" | "agent",
		operation: () => Promise<T>
	): Promise<T> {
		const pending = operation();
		const compensate = () => {
			if (!live(turn)) cancelRemote(turn, "user", target);
		};
		void pending.then(compensate, compensate);
		return rpc(turn, pending);
	}

	function observePcm(turn: Turn, sample: PcmObservation) {
		const speech = turn.speech;
		if (!live(turn) || !speech || turn.releasedAt === null) return;
		if (
			!Number.isFinite(sample.observedAt) ||
			sample.observedAt < turn.releasedAt ||
			sample.rms <= 0
		)
			return;
		speech.observed = true;
		if (turn.measured.has(speech.kind)) return;
		turn.measured.add(speech.kind);
		try {
			options.onLatency?.({
				...turn.identity,
				speechId: speech.id,
				kind: speech.kind,
				releasedAt: turn.releasedAt,
				observedAt: sample.observedAt,
				elapsedMs: sample.observedAt - turn.releasedAt,
				basis: sample.basis,
				origin: "renderer-release",
			});
		} catch (error) {
			report(error);
		}
	}

	async function speakQueue(turn: Turn) {
		if (turn.speaking || !live(turn)) return;
		turn.speaking = true;
		try {
			while (live(turn) && turn.queue.length) {
				const speech = turn.queue.shift();
				if (!speech) break;
				turn.speech = speech;
				let ended!: () => void;
				const ending = new Promise<void>((resolve) => {
					ended = resolve;
				});
				turn.ended = ended;
				publish({ phase: "speaking" });
				if (!live(turn)) return;
				await fromOrigin("voice", () =>
					rpc(
						turn,
						options.voice.speak(
							SpeakSchema.parse({ ...turn.identity, speechId: speech.id, text: speech.text }),
							turn.abort.signal
						)
					)
				);
				await fromOrigin("voice", () => bounded(ending, turn.abort.signal, speechTimeout));
				if (!live(turn)) return;
				const media = turn.media;
				if (media)
					await fromOrigin("media", () =>
						bounded(media.drain(turn.abort.signal), turn.abort.signal, speechTimeout)
					);
				if (!live(turn)) return;
				if (turn.claimId && !speech.observed)
					throw new VoiceFailure("media", new Error("Attention playback was not observed"));
				turn.speech = null;
				turn.ended = null;
			}
		} catch (error) {
			fail(turn, error);
		} finally {
			turn.speaking = false;
			if (live(turn)) {
				if (turn.agentDone) finish(turn);
				else publish({ phase: "thinking" });
			}
		}
	}
	function queue(turn: Turn, text: string, kind: Speech["kind"]) {
		if (!live(turn)) return;
		if (turn.queue.length >= MAX_QUEUE) throw new Error("Speech queue limit exceeded");
		SpeakSchema.shape.text.parse(text);
		turn.queue.push({ id: id(), text, kind, observed: false });
		if (kind === "answer") turn.hasAnswer = true;
		if (!turn.speaking) turn.pump = speakQueue(turn);
	}
	function answer(turn: Turn, delta: string, final = false) {
		if (turn.text.length + delta.length > MAX_TEXT)
			throw new VoiceFailure("agent", new Error("Agent response limit exceeded"));
		turn.text += delta;
		options.onAnswer?.(turn.text, { ...turn.identity });
		if (!live(turn)) return;
		for (const sentence of turn.sentences.push(delta, final)) queue(turn, sentence, "answer");
	}
	async function action(turn: Turn, value: AgentAction, sourceText: string) {
		if (!live(turn) || !sameTurn(value, turn.identity) || turn.actions.has(value.requestId)) return;
		if (turn.actions.size >= MAX_ACTIONS)
			throw new VoiceFailure("agent", new Error("Agent action limit exceeded"));
		turn.actions.add(value.requestId);
		if (value.kind === "narration-checkpoint") {
			if (turn.text.length !== value.throughTextLength || !sourceText.startsWith(turn.text))
				throw new VoiceFailure("agent", new Error("Narration checkpoint text prefix mismatch"));
			const checkpoint = options.onNarrationCheckpoint;
			if (!checkpoint)
				throw new VoiceFailure("agent", new Error("Narration checkpoint handler unavailable"));
			for (const sentence of turn.sentences.flush()) queue(turn, sentence, "answer");
			// The pump includes speak RPC, speech-ended and media.drain for every queued segment.
			// Its per-speech bounds and the whole-turn deadline also bound this checkpoint wait.
			while (live(turn) && (turn.speaking || turn.queue.length)) {
				if (!turn.pump) throw new Error("Speech pump unavailable");
				await bounded(turn.pump, turn.abort.signal, turnTimeout);
			}
			if (!live(turn)) return;
			await fromOrigin("agent", () =>
				rpc(turn, Promise.resolve(checkpoint(value, turn.abort.signal)))
			);
			return;
		}
		if (turn.claimId)
			throw new VoiceFailure("agent", new Error("Attention cannot change the workspace"));
		if (options.getConversationContext) {
			if (options.onConversationAction)
				await fromOrigin("agent", async () =>
					rpc(turn, Promise.resolve(options.onConversationAction?.(value, turn.abort.signal)))
				);
			return;
		}
		const current = ScreenContextSchema.parse(options.getScreenContext?.());
		if (!live(turn)) return;
		if (current.prId !== turn.prId || current.sequence !== value.screenSequence) {
			if (options.onActionIgnored)
				await fromOrigin("agent", async () =>
					rpc(turn, Promise.resolve(options.onActionIgnored?.(value, current)))
				);
			return;
		}
		if (options.onAction)
			await fromOrigin("agent", async () =>
				rpc(turn, Promise.resolve(options.onAction?.(value, current, turn.abort.signal)))
			);
	}
	async function recoverSnapshot(turn: Turn, text: string, actions: AgentAction[]) {
		if (!text.startsWith(turn.text))
			throw new VoiceFailure("agent", new Error("Agent snapshot changed already spoken text"));
		const recoverText = (through = text.length) => {
			if (through < turn.text.length || through > text.length || through > MAX_TEXT)
				throw new VoiceFailure("agent", new Error("Narration checkpoint text prefix mismatch"));
			answer(turn, text.slice(turn.text.length, through));
		};
		if (
			actions.some(
				(value) => value.kind === "narration-checkpoint" && !turn.actions.has(value.requestId)
			)
		) {
			// Compaction can omit checkpoint events. Replay effects in snapshot order and admit
			// only each checkpoint's prefix, never synthesize the following file's text early.
			for (const value of actions) {
				if (!live(turn)) return;
				if (turn.actions.has(value.requestId)) continue;
				if (value.kind === "narration-checkpoint") recoverText(value.throughTextLength);
				await action(turn, value, text);
			}
		}
		if (live(turn)) recoverText();
	}
	async function agentEvent(turn: Turn, event: AgentEvent, sourceText: string) {
		if (!live(turn) || event.sequence <= turn.agentSequence) return;
		turn.agentSequence = event.sequence;
		options.onEvent?.(event);
		if (!live(turn)) return;
		switch (event.kind) {
			case "acknowledgement":
				break; // Server acknowledgements never synthesize speech.
			case "text-delta":
				answer(turn, event.delta);
				break;
			case "action":
				await action(turn, event.action, sourceText);
				break;
			case "error":
				throw new VoiceFailure("agent", new Error(event.message));
			case "cancelled":
				stop("user");
				break;
			case "completed":
				break; // Drain all pages before completing.
		}
	}
	async function runAgent(turn: Turn, text: string) {
		try {
			const start = (() => {
				if (turn.claimId) {
					const attend = options.agent.attend;
					if (!attend) throw new Error("Attention is unavailable");
					return () =>
						attend(
							ConversationAttentionInputSchema.parse({
								...turn.identity,
								requestId: id(),
								claimId: turn.claimId,
							}),
							turn.abort.signal
						);
				}
				const base = { ...turn.identity, requestId: id(), text };
				let input: AgentTurnInput | ConversationTurnInput;
				if (options.getConversationContext) {
					const context = options.getConversationContext();
					input = ConversationTurnInputSchema.parse({
						...base,
						...(context.prId === undefined ? {} : { prId: context.prId }),
						...(context.screen === undefined ? {} : { screen: context.screen }),
						...(context.workspace === undefined ? {} : { workspace: context.workspace }),
					});
				} else {
					const screenContext = ScreenContextSchema.parse(options.getScreenContext?.());
					if (
						screenContext.browser &&
						(screenContext.browser.sessionId !== turn.identity.sessionId ||
							screenContext.browser.prId !== screenContext.prId)
					)
						throw new Error("Browser context does not belong to the current review session");
					turn.prId = screenContext.prId;
					input = AgentTurnInputSchema.parse({ ...base, screenContext });
				}
				return () => options.agent.start(input, turn.abort.signal);
			})();
			const started = await fromOrigin("agent", async () =>
				StartResultSchema.parse(await allocation(turn, "agent", start))
			);
			if (!live(turn)) return;
			if (!sameTurn(started, turn.identity))
				throw new VoiceFailure("agent", new Error("Mismatched agent start identity"));
			if (started.status === "error")
				throw new VoiceFailure("agent", new Error("Agent turn failed"));
			if (started.status === "cancelled") return stop("user");
			let stalled = 0;
			while (live(turn)) {
				const input = PollTurnSchema.parse({
					...turn.identity,
					afterSequence: turn.agentSequence,
					limit: 100,
				});
				const result = await fromOrigin("agent", async () =>
					PollTurnResultSchema.parse(await rpc(turn, options.agent.poll(input, turn.abort.signal)))
				);
				if (!live(turn)) return;
				if (!sameTurn(result, turn.identity) || result.status === "stale")
					throw new VoiceFailure("agent", new Error("Agent turn is stale"));
				// Failed pages cannot flush a partial answer, dispatch actions or imply completion.
				const failed = result.events.find(
					(event) => event.kind === "error" && event.sequence > turn.agentSequence
				);
				if (failed?.kind === "error" || result.status === "error")
					throw new VoiceFailure(
						"agent",
						new Error(failed?.kind === "error" ? failed.message : "Agent turn failed")
					);
				const previous = turn.agentSequence;
				const firstNew = result.events.find((event) => event.sequence > turn.agentSequence);
				if (firstNew && firstNew.sequence > turn.agentSequence + 1) {
					// A compacted event window has lost a prefix. Recover the full snapshot once.
					await recoverSnapshot(turn, result.text, result.actions);
					turn.agentSequence = result.sequence;
				} else {
					for (const event of result.events) await agentEvent(turn, event, result.text);
				}
				if (!live(turn)) return;
				// Empty pages can represent compaction. Recover only unsaid suffixes; never replay speech.
				if (result.events.length === 0 && result.sequence > turn.agentSequence) {
					await recoverSnapshot(turn, result.text, result.actions);
					turn.agentSequence = result.sequence;
				}
				if (turn.agentSequence >= result.sequence) {
					for (const value of result.actions) await action(turn, value, result.text);
					if (!live(turn)) return;
					if (result.status === "cancelled") return stop("user");
					if (result.status === "completed") {
						answer(turn, "", true);
						if (!turn.claimId && !turn.hasAnswer && completion) queue(turn, completion, "answer");
						turn.agentDone = true;
						finish(turn);
						return;
					}
				}
				stalled =
					result.sequence > turn.agentSequence && previous === turn.agentSequence ? stalled + 1 : 0;
				if (stalled >= 3)
					throw new VoiceFailure("agent", new Error("Agent event pagination made no progress"));
				await delay(turn.agentSequence < result.sequence ? 0 : pollInterval, turn.abort.signal);
			}
		} catch (error) {
			fail(turn, error);
		}
	}
	function acceptFinal(turn: Turn) {
		if (!live(turn) || turn.finalized || turn.releasedAt === null || turn.finalText === null)
			return;
		turn.finalized = true;
		const text = turn.finalText.trim();
		if (!text) {
			turn.agentDone = true;
			finish(turn);
			return;
		}
		if (ack) queue(turn, ack, "acknowledgement");
		if (live(turn)) void runAgent(turn, text);
	}
	function voiceEvent(turn: Turn, event: VoiceEvent) {
		if (!live(turn) || !sameTurn(event, turn.identity) || event.sequence <= turn.voiceSequence)
			return;
		turn.voiceSequence = event.sequence;
		options.onVoiceEvent?.(event);
		if (!live(turn)) return;
		if (event.kind === "error")
			throw new VoiceFailure(
				"voice",
				event.diagnostic ? new VoiceDiagnosticError(event.diagnostic) : new Error(event.message)
			);
		if (event.kind === "transcript" && !turn.finalized) {
			if (event.final) turn.finalText = event.text;
			publish({ transcript: event.text, transcriptFinal: event.final });
			if (!live(turn)) return;
			options.onTranscript?.({ ...turn.identity, text: event.text, final: event.final });
			if (event.final) acceptFinal(turn);
		}
		if (event.kind === "speech-ended" && event.speechId === turn.speech?.id) turn.ended?.();
	}
	async function pollVoice(turn: Turn) {
		try {
			while (live(turn)) {
				const input = VoicePollSchema.parse({
					...turn.identity,
					afterSequence: turn.voiceSequence,
				});
				const result = await fromOrigin("voice", async () =>
					VoicePollResultSchema.parse(await rpc(turn, options.voice.poll(input, turn.abort.signal)))
				);
				if (!live(turn)) return;
				for (const event of result.events) voiceEvent(turn, event);
				if (!live(turn)) return;
				await delay(result.events.length === 100 ? 0 : pollInterval, turn.abort.signal);
			}
		} catch (error) {
			fail(turn, error);
		}
	}
	async function connect(turn: Turn) {
		try {
			if (!turn.media) throw new Error("Voice media unavailable");
			await bounded(
				turn.media.connect(async (description) => {
					if (!live(turn)) throw new Error("Voice turn cancelled");
					const offer = VoiceOfferSchema.parse({
						...turn.identity,
						...description,
						keywords: turn.keywords,
					});
					return fromOrigin("voice", async () =>
						VoiceAnswerSchema.parse(
							await allocation(turn, "voice", () => options.voice.offer(offer, turn.abort.signal))
						)
					);
				}, turn.abort.signal),
				turn.abort.signal,
				mediaSetupTimeout,
				new VoiceDiagnosticError({ stage: "media", code: "timeout" })
			);
			if (!live(turn)) return;
			turn.ready = true;
			if (turn.claimId) turn.media.stopCapture();
			publish({ phase: turn.claimId ? "thinking" : "listening" });
			if (!live(turn)) return;
			void pollVoice(turn);
			if (turn.claimId) void runAgent(turn, "");
		} catch (error) {
			fail(turn, error, "media");
		}
	}

	function beginTurn(claimId: string | null) {
		if (disposed || (claimId && active)) return { status: "unavailable" } as const;
		const launch = ++captureSequence;
		if (!claimId) stop("push-to-talk");
		if (disposed || captureSequence !== launch) return { status: "unavailable" } as const;
		let identity: TurnIdentity;
		try {
			identity = TurnIdentitySchema.parse(
				options.allocateIdentity
					? options.allocateIdentity()
					: {
							sessionId,
							turnId: id(),
							generation: generation + 1,
						}
			);
			if (identity.sessionId !== sessionId || identity.generation <= generation)
				throw new Error("Voice identity must advance the current review session generation");
		} catch (error) {
			if (!disposed && captureSequence === launch) {
				publish({ phase: "error", error: asError(error).message });
				report(error);
			}
			return { status: "unavailable" } as const;
		}
		if (disposed || captureSequence !== launch) return { status: "unavailable" } as const;
		generation = identity.generation;
		const turn: Turn = {
			claimId,
			identity,
			keywords: [],
			abort: new AbortController(),
			media: null,
			deadline: null,
			ready: false,
			releasedAt: claimId ? now() : null,
			finalized: claimId !== null,
			finalText: null,
			voiceSequence: 0,
			agentSequence: 0,
			prId: null,
			actions: new Set(),
			text: "",
			sentences: new Sentences(),
			queue: [],
			speech: null,
			ended: null,
			measured: new Set(),
			agentDone: false,
			speaking: false,
			pump: null,
			hasAnswer: false,
			failure: null,
		};
		active = turn;
		publish({
			...identity,
			phase: "idle",
			transcript: "",
			transcriptFinal: false,
			error: undefined,
		});
		if (!live(turn)) return { status: "started", identity } as const;
		try {
			options.onTurnStart?.({ ...identity }, claimId ? "attention" : "voice");
		} catch (error) {
			fail(turn, error);
		}
		if (!live(turn)) return { status: "started", identity } as const;
		turn.deadline = setTimeout(() => fail(turn, new Error("Voice turn timed out")), turnTimeout);
		try {
			turn.keywords = VoiceOfferSchema.shape.keywords.parse(options.getKeywords?.() ?? []);
		} catch (error) {
			fail(turn, error);
			return { status: "started", identity } as const;
		}
		try {
			turn.media = options.media({
				pcm: (sample) => observePcm(turn, sample),
				disconnected: (error) => fail(turn, error, "media"),
			});
			void connect(turn);
		} catch (error) {
			fail(turn, error, "media");
		}
		return { status: "started", identity } as const;
	}

	return {
		beginCapture() {
			beginTurn(null);
		},
		beginReply(claimId) {
			if (!options.agent.attend) return { status: "unavailable" };
			return beginTurn(IdSchema.parse(claimId));
		},
		endCapture() {
			const turn = active;
			if (!turn || turn.releasedAt !== null) return;
			if (!turn.ready) return stop("user");
			turn.releasedAt = now();
			try {
				turn.media?.stopCapture();
			} catch (error) {
				fail(turn, error, "media");
				return;
			}
			try {
				publish({ phase: "transcribing" });
				if (!live(turn)) return;
				void fromOrigin("voice", () =>
					rpc(
						turn,
						options.voice.release(TurnIdentitySchema.parse(turn.identity), turn.abort.signal)
					)
				).catch((error) => fail(turn, error));
				acceptFinal(turn);
			} catch (error) {
				fail(turn, error);
			}
		},
		interrupt: (reason = "user") => {
			captureSequence++;
			stop(reason);
		},
		getPhase: () => state.phase,
		subscribe(listener) {
			if (disposed) return () => {};
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: () => state,
		getIdentity: () => (active ? { ...active.identity } : null),
		get connecting() {
			return active !== null && !active.ready;
		},
		get snapshot() {
			return state;
		},
		get transcript() {
			return state.transcript;
		},
		speakCompletion(identity, text) {
			const turn = active;
			if (!turn || !live(turn) || !sameTurn(identity, turn.identity) || !turn.finalized)
				return false;
			try {
				for (const sentence of new Sentences().push(SpeakSchema.shape.text.parse(text), true))
					queue(turn, sentence, "answer");
				return true;
			} catch (error) {
				fail(turn, error);
				return false;
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			stop("shutdown");
			listeners.clear();
		},
	};
}
