import type {
	SpeakInput,
	VoiceAnswer,
	VoiceEvent,
	VoiceOffer,
	VoicePoll,
	VoicePollResult,
} from "../../main/voice/protocol";
import type {
	AgentAction,
	AgentEvent,
	AgentTurnInput,
	AgentTurnStatus,
	CancelTurnInput,
	CancelTurnResult,
	ConversationTurnInput,
	PollTurn,
	PollTurnResult,
	ScreenContext,
	TurnIdentity,
	VoiceState,
} from "../../shared/contracts";

export type VoicePorts = {
	offer(input: VoiceOffer, signal: AbortSignal): Promise<VoiceAnswer>;
	release(input: TurnIdentity, signal: AbortSignal): Promise<void>;
	speak(input: SpeakInput, signal: AbortSignal): Promise<void>;
	cancel(input: TurnIdentity, signal: AbortSignal): Promise<void>;
	poll(input: VoicePoll, signal: AbortSignal): Promise<VoicePollResult>;
};
export type AgentPorts = {
	start(
		input: AgentTurnInput | ConversationTurnInput,
		signal: AbortSignal
	): Promise<TurnIdentity & { status: AgentTurnStatus }>;
	poll(input: PollTurn, signal: AbortSignal): Promise<PollTurnResult>;
	cancel(input: CancelTurnInput, signal: AbortSignal): Promise<CancelTurnResult>;
};

export type PcmObservation = {
	/** performance.now() time of a non-silent sample in a running output graph. */
	observedAt: number;
	rms: number;
	basis: "webaudio-output-analyser";
};
export type LatencyObservation = TurnIdentity & {
	speechId: string;
	kind: "acknowledgement" | "answer";
	releasedAt: number;
	observedAt: number;
	elapsedMs: number;
	basis: PcmObservation["basis"];
	/** This observes PCM before the physical output device, not acoustic loopback. */
	origin: "renderer-release";
};

/** One handle per generation. close() must also invalidate pending permission/setup. */
export type VoiceMedia = {
	connect(
		offer: (description: Pick<VoiceOffer, "sdp" | "type">) => Promise<VoiceAnswer>,
		signal: AbortSignal
	): Promise<void>;
	stopCapture(): void;
	/** Drain remote audio after sidecar speech-ended before attributing the next speech. */
	drain(signal: AbortSignal): Promise<void>;
	close(): void;
};
export type MediaFactory = (observer: {
	pcm(observation: PcmObservation): void;
	disconnected(error: Error): void;
}) => VoiceMedia;

export type TranscriptUpdate = TurnIdentity & { text: string; final: boolean };
export type VoiceTurnEnd =
	| { status: "completed" }
	| { status: "cancelled"; reason: CancelTurnInput["reason"] }
	| {
			status: "failed";
			error: string;
			origin: "agent" | "voice" | "media" | "controller";
			/** Only agent failures preserve a healthy, explicitly opened hands-free session. */
			recoverable: boolean;
	  };
export type VoiceControllerOptions = {
	voice: VoicePorts;
	agent: AgentPorts;
	media: MediaFactory;
	/** Use the UI review session for both typed and spoken turns. */
	sessionId?: string;
	/** Synchronous shared allocator; requires sessionId and an increasing generation. */
	allocateIdentity?(): TurnIdentity;
	/** Display lifecycle only. These hooks must never start a second agent turn. */
	onTurnStart?(identity: TurnIdentity): void;
	onTurnEnd?(identity: TurnIdentity, result: VoiceTurnEnd): void;
	/** V1 conversation mode: no screen or review is required; takes precedence over getScreenContext. */
	getConversationContext?(): Pick<ConversationTurnInput, "prId" | "screen">;
	/** Legacy review mode requires a real screen context. */
	getScreenContext?(): ScreenContext;
	/** PR symbols and paths supplied by composition; snapshotted when capture begins. */
	getKeywords?(): string[];
	/** Product copy is injected; the renderer never routes user phrases or chooses tools. */
	acknowledgementText?: string;
	/** Generic product copy for a completed turn with no answer text, never an invented outcome. */
	completionText?: string;
	onTranscript?(update: TranscriptUpdate): void;
	onEvent?(event: AgentEvent): void;
	onVoiceEvent?(event: VoiceEvent): void;
	onAnswer?(text: string, identity: TurnIdentity): void;
	/** Same live conversation turn, deduplicated by requestId. UI applies/ignores and awaits its receipt. */
	onConversationAction?(action: AgentAction, signal: AbortSignal): void | Promise<void>;
	/** Check signal/current screen again immediately before any asynchronous UI effect. */
	onAction?(action: AgentAction, screen: ScreenContext, signal: AbortSignal): void | Promise<void>;
	/** Same live turn only: report a PR/screen-filtered action once so UI can send an ignored receipt. */
	onActionIgnored?(action: AgentAction, screen: ScreenContext): void | Promise<void>;
	onLatency?(observation: LatencyObservation): void;
	onError?(error: Error): void;
	now?: () => number;
	id?: () => string;
	pollIntervalMs?: number;
	rpcTimeoutMs?: number;
	/** Whole media setup budget, including human permission prompt; defaults to 90 seconds. */
	mediaSetupTimeoutMs?: number;
	turnTimeoutMs?: number;
	speechTimeoutMs?: number;
};

/** Structurally satisfies UI review/services.ts VoiceAdapter without importing the UI lane. */
export type VoiceController = {
	beginCapture(): void;
	endCapture(): void;
	interrupt(reason?: CancelTurnInput["reason"]): void;
	getPhase(): VoiceState["phase"];
	subscribe(listener: () => void): () => void;
	getSnapshot(): Readonly<VoiceState>;
	getIdentity(): TurnIdentity | null;
	readonly connecting: boolean;
	readonly snapshot: Readonly<VoiceState>;
	readonly transcript: string;
	/** Results of background work for this still-current turn; stale notifications are rejected. */
	speakCompletion(identity: TurnIdentity, text: string): boolean;
	dispose(): void;
};
