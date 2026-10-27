import type { ActivityOptions, SpeechFrame } from "./activity";
import type { MediaFactory, VoiceController, VoiceControllerOptions, VoiceMedia } from "./types";

export type BufferedVoiceMedia = VoiceMedia & {
	append(samples: Float32Array): void;
	/** Resolves only after all buffered audio has been paced into the connected RTC sender. */
	finishInput(): Promise<void>;
};
export type HandsFreeAudio = {
	start(signal: AbortSignal): Promise<void>;
	createTurn(observer: Parameters<MediaFactory>[0]): BufferedVoiceMedia;
	close(): void;
};
export type HandsFreeAudioFactory = (observer: {
	frame(frame: SpeechFrame): void;
	failed(error: Error): void;
}) => HandsFreeAudio;
export type HandsFreeSnapshot = Readonly<{
	phase: "stopped" | "starting" | "listening" | "capturing" | "responding" | "error";
	active: boolean;
	error?: string;
}>;
export type HandsFreeOptions = Omit<VoiceControllerOptions, "media" | "acknowledgementText"> & {
	audio?: HandsFreeAudioFactory;
	activity?: ActivityOptions;
	/** Optional user-selected inactivity cap; disabled by default so quiet code reading keeps the session armed. */
	idleTimeoutMs?: number;
	frameTimeoutMs?: number;
	/** Optional user-selected session cap; disabled by default. Stop/error/dispose always releases hardware. */
	sessionTimeoutMs?: number;
};
export type HandsFreeVoiceController = Pick<
	VoiceController,
	"getSnapshot" | "getPhase" | "getIdentity" | "subscribe" | "interrupt" | "dispose"
> & {
	startListening(): Promise<void>;
	stopListening(reason?: Parameters<VoiceController["interrupt"]>[0]): void;
	getSessionSnapshot(): HandsFreeSnapshot;
};
