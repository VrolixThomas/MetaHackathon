import { createStore } from "zustand/vanilla";
import type {
	AgentAction,
	AppConfiguration,
	CancelTurnInput,
	ConversationPRContext,
	ConversationTurnInput,
	PullRequest,
	TurnIdentity,
	VoiceSetupStatus,
} from "../../shared/contracts";
import type { PreparedController } from "../prepared/controller";
import { bounded, delay } from "../voice/async";
import type { ConversationApi } from "./api";
import { conversationErrorMessage } from "./errors";

export type Phase =
	| "listening"
	| "transcribing"
	| "thinking"
	| "speaking"
	| "complete"
	| "cancelled"
	| "error";
export type Exchange = TurnIdentity & {
	requestId?: string;
	source: "typed" | "voice";
	question: string;
	answer: string;
	phase: Phase;
};
export type VoiceHandle = {
	beginCapture(): void;
	endCapture(): void;
	interrupt(reason?: CancelTurnInput["reason"]): void;
	dispose(): void;
};
export type HandsFreeHandle = {
	start(): Promise<void>;
	stop(): void;
	interrupt(): void;
};
type Active = TurnIdentity & {
	abort: AbortController;
	source: Exchange["source"];
	context: Pick<ConversationTurnInput, "prId" | "screen">;
};
export type ConversationState = {
	exchanges: Exchange[];
	active: TurnIdentity | null;
	phase: Phase | "idle" | "connecting";
	config: AppConfiguration | null;
	envPath: string | null;
	configBusy: boolean;
	voice: VoiceSetupStatus | null;
	handsFree: boolean;
	handsFreeStarting: boolean;
	error: string;
	githubError: string;
	githubBusy: boolean;
	account: { login: string; avatar_url: string } | null;
	prs: PullRequest[];
	selected: ConversationPRContext | null;
};
const same = (a: TurnIdentity, b: TurnIdentity) =>
	a.sessionId === b.sessionId && a.turnId === b.turnId && a.generation === b.generation;
const identity = (input: TurnIdentity): TurnIdentity => ({
	sessionId: input.sessionId,
	turnId: input.turnId,
	generation: input.generation,
});

export function createConversationController(
	api: ConversationApi,
	options: { id?: () => string; pollInterval?: number } = {}
) {
	const id = options.id ?? (() => crypto.randomUUID());
	const sessionId = `conversation-${id()}`;
	let generation = 0;
	let lastStartedGeneration = -1;
	let active: Active | null = null;
	let voice: VoiceHandle | null = null;
	let handsFree: HandsFreeHandle | null = null;
	let handsFreeEpoch = 0;
	let review: Pick<PreparedController, "getContext" | "applyAction"> | null = null;
	let disposed = false;
	let configEpoch = 0;
	let githubEpoch = 0;
	let selectionEpoch = 0;
	let captureEpoch = 0;
	let captureMode: "hold" | "toggle" | null = null;
	let voiceTimer: ReturnType<typeof setTimeout> | undefined;
	const store = createStore<ConversationState>(() => ({
		exchanges: [],
		active: null,
		phase: "idle",
		config: null,
		envPath: null,
		configBusy: false,
		voice: null,
		handsFree: false,
		handsFreeStarting: false,
		error: "",
		githubError: "",
		githubBusy: false,
		account: null,
		prs: [],
		selected: null,
	}));
	const live = (turn: TurnIdentity) =>
		!disposed && !!active && same(active, turn) && !active.abort.signal.aborted;
	const updateExchange = (turn: TurnIdentity, patch: Partial<Exchange>) => {
		if (!live(turn)) return;
		store.setState((state) => ({
			exchanges: state.exchanges.map((entry) =>
				same(entry, turn) ? { ...entry, ...patch } : entry
			),
		}));
	};
	const cancelRemote = (turn: TurnIdentity, reason: CancelTurnInput["reason"]) => {
		void api.cancel({ ...identity(turn), requestId: id(), reason }).catch(() => {});
	};
	function cancelActive(reason: CancelTurnInput["reason"] = "user", keepListening = false) {
		captureMode = null;
		captureEpoch++;
		const old = active;
		active = null;
		if (old) {
			old.abort.abort();
			store.setState((state) => ({
				exchanges: state.exchanges.map((entry) =>
					same(entry, old) ? { ...entry, phase: "cancelled" } : entry
				),
				active: null,
				phase: "idle",
			}));
			if (old.source === "typed") cancelRemote(old, reason);
		} else store.setState({ phase: "idle" });
		if (keepListening && handsFree) handsFree.interrupt();
		else voice?.interrupt(reason);
	}
	function stop(reason: CancelTurnInput["reason"] = "user") {
		handsFreeEpoch++;
		store.setState({ handsFree: false, handsFreeStarting: false });
		cancelActive(reason);
		handsFree?.stop();
	}
	async function startConversation() {
		if (disposed || store.getState().handsFree || store.getState().handsFreeStarting) return;
		if (!handsFree || store.getState().voice?.phase !== "ready") {
			store.setState({ error: "Voice is not ready yet. Open Settings to check voice setup." });
			return;
		}
		cancelActive();
		const epoch = ++handsFreeEpoch;
		const handle = handsFree;
		store.setState({ handsFreeStarting: true, error: "" });
		try {
			const microphone =
				store.getState().config?.microphone === "granted" ? "granted" : await requestMicrophone();
			if (disposed || epoch !== handsFreeEpoch) return;
			if (microphone !== "granted")
				throw new Error("Microphone access is unavailable. Check Settings.");
			await bounded(handle.start(), AbortSignal.timeout(90_000), 90_000);
			if (disposed || epoch !== handsFreeEpoch) return;
			store.setState({ handsFree: true, handsFreeStarting: false });
		} catch (error) {
			if (disposed || epoch !== handsFreeEpoch) return;
			stop();
			store.setState({
				error: conversationErrorMessage(error, store.getState().config?.microphone),
			});
		}
	}
	function interruptReply() {
		cancelActive("user", store.getState().handsFree);
	}
	const allocateIdentity = (): TurnIdentity => ({
		sessionId,
		turnId: id(),
		generation: ++generation,
	});
	function begin(turn: TurnIdentity, source: Exchange["source"], question: string) {
		if (disposed || turn.sessionId !== sessionId || turn.generation !== generation) return false;
		if (active && same(active, turn)) return true;
		if (turn.generation <= lastStartedGeneration) return false;
		lastStartedGeneration = turn.generation;
		if (active) {
			active.abort.abort();
			if (active.source === "typed") cancelRemote(active, "push-to-talk");
		}
		active = { ...turn, source, abort: new AbortController(), context: getConversationContext() };
		store.setState((state) => ({
			active: identity(turn),
			phase: source === "voice" ? "connecting" : "thinking",
			error: "",
			exchanges: [
				...state.exchanges,
				{
					...turn,
					source,
					question,
					answer: "",
					phase: source === "voice" ? ("listening" as const) : ("thinking" as const),
				},
			].slice(-100),
		}));
		return true;
	}
	function finish(turn: TurnIdentity, phase: "complete" | "cancelled" | "error", error = "") {
		if (!live(turn)) return;
		updateExchange(turn, { phase });
		active?.abort.abort();
		active = null;
		captureMode = null;
		store.setState({ active: null, phase: "idle", error });
		if (phase === "error") {
			handsFreeEpoch++;
			store.setState({ handsFree: false, handsFreeStarting: false });
			handsFree?.stop();
		}
	}
	async function submit(text: string) {
		const question = text.trim();
		if (!question || disposed) return;
		stop();
		const turn = allocateIdentity();
		begin(turn, "typed", question);
		const current = active;
		if (!current) return;
		const context = getConversationContext();
		current.context = context;
		const input: ConversationTurnInput = {
			...turn,
			requestId: id(),
			text: question,
			...context,
		};
		updateExchange(turn, { requestId: input.requestId });
		try {
			const starting = api.start(input);
			void starting
				.then(() => {
					if (!live(turn)) cancelRemote(turn, "user");
				})
				.catch(() => {});
			const started = await bounded(starting, current.abort.signal, 30_000);
			if (!same(started, turn)) throw new Error("Unexpected turn identity");
			let cursor = 0;
			let answer = "";
			const applied = new Set<string>();
			const action = async (value: AgentAction) => {
				if (applied.has(value.requestId)) return;
				await applyConversationAction(value, current.abort.signal);
				applied.add(value.requestId);
			};
			while (live(turn)) {
				const result = await bounded(
					api.poll({ ...turn, afterSequence: cursor, limit: 100 }),
					current.abort.signal,
					30_000
				);
				if (!live(turn)) return;
				if (!same(result, turn) || result.status === "stale" || result.sequence < cursor)
					throw new Error("Conversation changed");
				const events = result.events.filter((event) => event.sequence > cursor);
				if (
					(events[0] && events[0].sequence > cursor + 1) ||
					(!events.length && result.sequence > cursor)
				) {
					answer = result.text;
					for (const value of result.actions) await action(value);
					cursor = result.sequence;
				} else {
					for (const event of events) {
						if (event.kind === "text-delta") answer += event.delta;
						if (event.kind === "action") await action(event.action);
						cursor = event.sequence;
					}
					if (cursor === result.sequence) answer = result.text;
				}
				updateExchange(turn, { answer: answer.slice(0, 50_000) });
				if (cursor < result.sequence) continue;
				if (result.status === "completed") {
					finish(turn, "complete");
					return;
				}
				if (result.status === "cancelled") {
					finish(turn, "cancelled");
					return;
				}
				if (result.status === "error") {
					const failure = result.events.find((event) => event.kind === "error");
					throw new Error(
						failure?.kind === "error"
							? failure.message
							: "The conversation could not complete this reply. Please try again."
					);
				}
				await delay(options.pollInterval ?? 150, current.abort.signal);
			}
		} catch (error) {
			if (live(turn)) {
				cancelRemote(turn, "user");
				finish(turn, "error", conversationErrorMessage(error));
			}
		}
	}
	function watchVoice(epoch: number) {
		clearTimeout(voiceTimer);
		voiceTimer = setTimeout(async () => {
			try {
				const status = await api.voiceStatus();
				if (disposed || epoch !== configEpoch) return;
				store.setState({
					voice: status,
					...(status.phase === "error"
						? { error: conversationErrorMessage(status.error, store.getState().config?.microphone) }
						: {}),
				});
				if (status.phase === "preparing") watchVoice(epoch);
			} catch {
				if (!disposed && epoch === configEpoch)
					store.setState({
						voice: null,
						error: "Voice status is unavailable. Retry voice or reload configuration.",
					});
			}
		}, 1000);
	}
	async function prepareVoice(epoch = configEpoch) {
		const config = store.getState().config;
		if (!config?.configured.meta || !config.configured.elevenlabs || !config.voiceId) return;
		try {
			const status = await api.prepareVoice();
			if (disposed || epoch !== configEpoch) return;
			store.setState({
				voice: status,
				...(status.phase === "error"
					? { error: conversationErrorMessage(status.error, store.getState().config?.microphone) }
					: {}),
			});
			if (status.phase === "preparing") watchVoice(epoch);
		} catch {
			if (!disposed && epoch === configEpoch)
				store.setState({
					voice: null,
					error: "Voice could not start. Check configuration, then retry voice.",
				});
		}
	}
	async function configure(reload = false) {
		stop();
		clearTimeout(voiceTimer);
		const epoch = ++configEpoch;
		store.setState({ configBusy: true, voice: null, error: "" });
		let loaded = false;
		try {
			const config = await (reload ? api.reloadConfig() : api.config());
			if (disposed || epoch !== configEpoch) return;
			store.setState({
				config,
				envPath: config.envPath,
				error: config.error ?? "",
				...(!config.configured.github ? { account: null, prs: [], selected: null } : {}),
			});
			loaded = true;
			if (config.error) return;
			const status = await api.voiceStatus();
			if (disposed || epoch !== configEpoch) return;
			store.setState({
				voice: status,
				...(status.phase === "error"
					? { error: conversationErrorMessage(status.error, store.getState().config?.microphone) }
					: {}),
			});
			if (status.phase === "preparing") watchVoice(epoch);
			else if (status.phase !== "ready") await prepareVoice(epoch);
		} catch {
			if (!disposed && epoch === configEpoch)
				store.setState({
					config: loaded ? store.getState().config : null,
					error: loaded
						? "Voice status is unavailable. Retry voice or reload configuration."
						: "Configuration is unavailable. Open the configuration file or try Reload.",
				});
		} finally {
			if (!disposed && epoch === configEpoch) store.setState({ configBusy: false });
		}
	}
	async function requestMicrophone() {
		try {
			const microphone = await api.requestMicrophone();
			if (!disposed)
				store.setState((state) => ({
					config: state.config ? { ...state.config, microphone } : null,
				}));
			return microphone;
		} catch {
			if (!disposed)
				store.setState({
					error: "Microphone status is unavailable. Check Configuration and try again.",
				});
			return "unknown" as const;
		}
	}
	async function startCapture(mode: "hold" | "toggle") {
		if (disposed || captureMode) return;
		if (active) {
			stop();
			return;
		}
		if (!voice || store.getState().voice?.phase !== "ready") {
			store.setState({ error: "Voice is not ready yet. Check Configuration or retry voice." });
			return;
		}
		captureMode = mode;
		const epoch = ++captureEpoch;
		store.setState({ phase: "connecting", error: "" });
		let microphone = store.getState().config?.microphone;
		if (microphone !== "granted") microphone = await requestMicrophone();
		if (disposed || epoch !== captureEpoch || !captureMode) return;
		if (microphone !== "granted") {
			captureMode = null;
			store.setState({
				phase: "idle",
				error: "Microphone access is unavailable. Check its status in Configuration.",
			});
			return;
		}
		voice.beginCapture();
	}
	function releaseCapture() {
		if (!captureMode) return;
		captureMode = null;
		captureEpoch++;
		if (active?.source === "voice") voice?.endCapture();
		else store.setState({ phase: "idle" });
	}
	async function refreshGitHub(connect = false) {
		const epoch = ++githubEpoch;
		store.setState({ githubBusy: true, githubError: "" });
		try {
			const account = await (connect ? api.githubSignIn() : api.githubAccount());
			const prs = await api.reviewRequests();
			if (!disposed && epoch === githubEpoch) store.setState({ account, prs });
		} catch {
			if (!disposed && epoch === githubEpoch)
				store.setState({
					githubError:
						"Could not load GitHub. Connect your GitHub CLI account or check GITHUB_TOKEN in configuration.",
				});
		} finally {
			if (!disposed && epoch === githubEpoch) store.setState({ githubBusy: false });
		}
	}
	async function selectPR(pr: PullRequest | null) {
		const epoch = ++selectionEpoch;
		store.setState({ selected: null, githubError: "", githubBusy: false });
		if (!pr) return;
		store.setState({ githubBusy: true });
		try {
			const selected = await api.prContext(pr.id);
			if (selected.pr.id !== pr.id) throw new Error("Unexpected pull request");
			if (!disposed && epoch === selectionEpoch) {
				store.setState({ selected });
			}
		} catch {
			if (!disposed && epoch === selectionEpoch)
				store.setState({
					githubError: "Could not load this pull request. Refresh and select it again.",
				});
		} finally {
			if (!disposed && epoch === selectionEpoch) store.setState({ githubBusy: false });
		}
	}
	function getConversationContext(): Pick<ConversationTurnInput, "prId" | "screen"> {
		if (review) return review.getContext();
		const prId = store.getState().selected?.pr.id;
		return prId ? { prId } : {};
	}
	function applyConversationAction(action: AgentAction, signal?: AbortSignal) {
		const turn = active;
		return (
			review?.applyAction(
				action,
				() => {
					if (!turn || !live(turn) || !same(turn, action) || signal?.aborted) return false;
					if (action.kind !== "review-navigation") return true;
					const context = turn.context;
					return (
						context.prId === action.navigation.prId &&
						(!context.screen?.reviewId || context.screen.reviewId === action.navigation.reviewId) &&
						(!context.screen?.headSha || context.screen.headSha === action.navigation.headSha) &&
						(!context.screen?.baseSha || context.screen.baseSha === action.navigation.baseSha)
					);
				},
				signal
			) ?? Promise.resolve("ignored" as const)
		);
	}
	return {
		store,
		sessionId,
		allocateIdentity,
		submit,
		stop,
		startConversation,
		endConversation: () => stop(),
		toggleConversation: () => {
			if (store.getState().handsFree || store.getState().handsFreeStarting) stop();
			else void startConversation();
		},
		interruptReply,
		configure,
		requestMicrophone,
		refreshGitHub,
		selectPR,
		getConversationContext,
		applyConversationAction,
		attachReview: (port: Pick<PreparedController, "getContext" | "applyAction">) => {
			review = port;
		},
		attachVoice: (handle: VoiceHandle) => {
			voice = handle;
		},
		attachHandsFree: (handle: HandsFreeHandle | null) => {
			if (handsFree && handsFree !== handle) stop();
			handsFree = handle;
		},
		handsFreeStopped: (error?: unknown) => {
			if (disposed) return;
			handsFreeEpoch++;
			store.setState({ handsFree: false, handsFreeStarting: false });
			cancelActive();
			if (error)
				store.setState({
					error: conversationErrorMessage(error, store.getState().config?.microphone),
				});
		},
		requestStarted: (input: ConversationTurnInput) => {
			if (active && live(input)) active.context = { prId: input.prId, screen: input.screen };
			updateExchange(input, { requestId: input.requestId });
		},
		beginVoice: (turn: TurnIdentity) => begin(turn, "voice", ""),
		transcript: (turn: TurnIdentity, text: string) => updateExchange(turn, { question: text }),
		answer: (turn: TurnIdentity, text: string) => updateExchange(turn, { answer: text }),
		finishVoice: finish,
		voicePhase: (phase: ConversationState["phase"]) => {
			if (active?.source === "voice") store.setState({ phase });
		},
		voiceError: (error: unknown) => {
			if (!disposed && (!active || active.source === "voice"))
				store.setState({
					error: conversationErrorMessage(error, store.getState().config?.microphone),
				});
		},
		press: () => {
			void startCapture("hold");
		},
		release: releaseCapture,
		toggle: () => {
			if (store.getState().handsFree || store.getState().handsFreeStarting) stop();
			else void startConversation();
		},
		retryVoice: () => {
			stop();
			store.setState({ error: "" });
			return prepareVoice();
		},
		openEnv: async () => {
			try {
				await api.openEnv();
			} catch {
				if (!disposed)
					store.setState({
						error: "Could not open the configuration file. Use the path shown in Configuration.",
					});
			}
		},
		dismissError: () => store.setState({ error: "" }),
		dispose: () => {
			if (disposed) return;
			stop("shutdown");
			disposed = true;
			clearTimeout(voiceTimer);
			voice?.dispose();
			void api.release(sessionId).catch(() => {});
		},
	};
}
export type ConversationController = ReturnType<typeof createConversationController>;
