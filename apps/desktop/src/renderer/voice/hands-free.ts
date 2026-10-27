import { VoiceDiagnosticError } from "../../main/voice/diagnostics";
import type { CancelTurnInput, TurnIdentity } from "../../shared/contracts";
import { type SpeechFrame, VoiceActivityDetector } from "./activity";
import { aborted, asError, bounded } from "./async";
import { createVoiceController, sameTurn } from "./controller";
import { createBrowserHandsFreeAudioFactory } from "./hands-free-audio";
import type {
	BufferedVoiceMedia,
	HandsFreeAudio,
	HandsFreeOptions,
	HandsFreeSnapshot,
	HandsFreeVoiceController,
} from "./hands-free-types";
import type { MediaFactory } from "./types";

type Session = {
	audio: HandsFreeAudio | null;
	abort: AbortController;
	detector: VoiceActivityDetector;
	ready: boolean;
	startedAt: number;
	lastFrame: number;
	lastActivity: number;
	noiseTurns: number[];
	preroll: SpeechFrame[];
	prerollMs: number;
	capture: Capture | null;
	timer?: ReturnType<typeof setInterval>;
};
type Capture = { media?: BufferedVoiceMedia; identity?: TurnIdentity };
const timeout = () => new VoiceDiagnosticError({ stage: "media", code: "timeout" });
function duration(value: number | undefined, fallback: number, maximum: number) {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 100 || value > maximum)
		throw new Error("Invalid hands-free timeout");
	return value;
}

/** Explicit microphone session with local endpointing. Each utterance still owns one cancellable voice/agent identity. */
export function createHandsFreeVoiceController(
	options: HandsFreeOptions
): HandsFreeVoiceController {
	const now = options.now ?? (() => performance.now());
	const idleTimeout = duration(options.idleTimeoutMs, Number.POSITIVE_INFINITY, 300_000);
	const frameTimeout = duration(options.frameTimeoutMs, 2000, 5000);
	const sessionTimeout = duration(options.sessionTimeoutMs, Number.POSITIVE_INFINITY, 60 * 60_000);
	let session: Session | null = null;
	let starting: Promise<void> | null = null;
	let disposed = false;
	let turnObserver: Parameters<MediaFactory>[0] | undefined;
	let snapshot: HandsFreeSnapshot = Object.freeze({ phase: "stopped", active: false });
	const listeners = new Set<() => void>();
	function notify() {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				/* Observers cannot prevent cleanup. */
			}
		}
	}
	function publish(phase: HandsFreeSnapshot["phase"], error?: Error) {
		snapshot = Object.freeze({
			phase,
			active: !["stopped", "error"].includes(phase),
			...(error ? { error: error.message } : {}),
		});
		notify();
	}
	function closeSession(error?: Error, reason: CancelTurnInput["reason"] = "user") {
		let failure = error;
		const current = session;
		if (!current) return;
		session = null;
		starting = null;
		turnObserver = undefined;
		clearInterval(current.timer);
		current.abort.abort();
		try {
			current.audio?.close();
		} catch {
			failure ??= new VoiceDiagnosticError({ stage: "media", code: "failed" });
		}
		current.preroll.length = 0;
		current.capture = null;
		current.detector.reset();
		voice.interrupt(reason);
		publish(failure ? "error" : "stopped", failure);
	}
	function report(error: Error) {
		try {
			options.onError?.(error);
		} catch {
			/* Cleanup already completed. */
		}
	}
	function fail(current: Session, error: Error) {
		if (session !== current) return;
		if (voice.getIdentity() && turnObserver) {
			// Route through the existing first-failure/cancel path whenever a turn exists.
			turnObserver.disconnected(error);
		} else {
			closeSession(error);
			report(error);
		}
	}
	function refresh() {
		if (!session || !session.ready) {
			notify();
			return;
		}
		if (voice.getPhase() === "error" && voice.getIdentity()) return;
		const phase = session.capture ? "capturing" : voice.getIdentity() ? "responding" : "listening";
		if (snapshot.phase !== phase) publish(phase);
		else notify();
	}
	const voice = createVoiceController({
		...options,
		acknowledgementText: undefined,
		mediaSetupTimeoutMs: options.mediaSetupTimeoutMs ?? 12_000,
		media: (observer) => {
			if (!session?.ready || !session.capture || !session.audio) throw aborted();
			turnObserver = observer;
			const media = session.audio.createTurn(observer);
			session.capture.media = media;
			return media;
		},
		onTurnEnd: (identity, result) => {
			if (session) {
				if (session.capture?.identity && sameTurn(identity, session.capture.identity))
					session.capture = null;
				session.lastActivity = now();
				if (result.status === "failed") closeSession(new Error(result.error));
				else refresh();
			}
			options.onTurnEnd?.(identity, result);
		},
		onError: (error) => {
			if (session) closeSession(error);
			report(error);
		},
	});
	const unsubscribe = voice.subscribe(refresh);
	function beginUtterance(current: Session) {
		voice.interrupt("push-to-talk"); // Synchronous output disconnect and explicit dual cancellation.
		if (session !== current) return;
		const capture: Capture = {};
		current.capture = capture;
		voice.beginCapture();
		if (session !== current || current.capture !== capture || !capture.media) return;
		const identity = voice.getIdentity();
		if (!identity) return;
		capture.identity = identity;
		for (const frame of current.preroll) capture.media.append(frame.samples);
		current.lastActivity = now();
		refresh();
	}
	function endUtterance(current: Session) {
		const capture = current.capture;
		current.capture = null;
		if (!capture?.media || !capture.identity) return;
		const identity = capture.identity;
		refresh();
		void bounded(capture.media.finishInput(), current.abort.signal, 17_000, timeout())
			.then(() => {
				const active = voice.getIdentity();
				if (session === current && active && sameTurn(identity, active)) voice.endCapture();
			})
			.catch((error) => {
				const active = voice.getIdentity();
				if (session === current && active && sameTurn(identity, active))
					fail(current, asError(error));
			});
	}
	function frame(current: Session, input: SpeechFrame) {
		if (session !== current || current.abort.signal.aborted) return;
		current.lastFrame = now();
		const ms = (input.samples.length / input.sampleRate) * 1000;
		// Detector validates the frame, including finite PCM and bounded duration, before it is buffered.
		const decision = current.detector.process(input, voice.getPhase() === "speaking");
		const buffered = current.detector.isPlaybackEcho
			? { ...input, samples: new Float32Array(input.samples.length) }
			: input;
		current.preroll.push(buffered);
		current.prerollMs += ms;
		while (current.prerollMs > 700 && current.preroll.length > 1) {
			const old = current.preroll.shift();
			if (old) current.prerollMs -= (old.samples.length / old.sampleRate) * 1000;
		}
		if (!current.ready) {
			current.detector.reset();
			return;
		}
		if (decision === "limit") {
			fail(current, timeout());
			return;
		}
		if (decision === "start") beginUtterance(current);
		else current.capture?.media?.append(buffered.samples);
		if (decision === "end") endUtterance(current);
		if (decision === "noise") {
			current.capture = null;
			voice.interrupt("user");
			current.noiseTurns = current.noiseTurns.filter((time) => now() - time < 30_000);
			current.noiseTurns.push(now());
			if (current.noiseTurns.length >= 3) fail(current, timeout());
			else refresh();
		}
	}
	return {
		startListening() {
			if (disposed) return Promise.reject(aborted());
			if (starting) return starting;
			if (session) return Promise.resolve();
			const current: Session = {
				audio: null,
				abort: new AbortController(),
				detector: new VoiceActivityDetector(options.activity),
				ready: false,
				startedAt: now(),
				lastFrame: now(),
				lastActivity: now(),
				noiseTurns: [],
				preroll: [],
				prerollMs: 0,
				capture: null,
			};
			session = current;
			try {
				current.audio = (options.audio ?? createBrowserHandsFreeAudioFactory())({
					frame: (input) => {
						try {
							frame(current, input);
						} catch (error) {
							fail(
								current,
								error instanceof VoiceDiagnosticError
									? error
									: new VoiceDiagnosticError({ stage: "media", code: "protocol" })
							);
						}
					},
					failed: (error) => fail(current, error),
				});
				if (session !== current || disposed) {
					current.audio.close();
					return Promise.reject(aborted());
				}
				publish("starting");
				if (session !== current || disposed) {
					current.audio.close();
					return Promise.reject(aborted());
				}
				const pending = current.audio.start(current.abort.signal);
				starting = bounded(pending, current.abort.signal, 65_000, timeout())
					.then(() => {
						if (session !== current || disposed) throw aborted();
						current.ready = true;
						current.lastFrame = current.lastActivity = now();
						current.timer = setInterval(() => {
							if (session !== current) return;
							if (now() - current.lastFrame > frameTimeout) fail(current, timeout());
							else if (
								now() - current.startedAt > sessionTimeout ||
								(!voice.getIdentity() && now() - current.lastActivity > idleTimeout)
							)
								closeSession();
						}, 100);
						refresh();
					})
					.catch((error) => {
						if (session === current) {
							closeSession(asError(error));
							report(asError(error));
						}
						throw error;
					})
					.finally(() => {
						if (session === current) starting = null;
					});
				return starting;
			} catch (error) {
				// Factory failure occurs before any hardware; preserve the stopped/error gate.
				session = null;
				current.abort.abort();
				current.audio?.close();
				publish("error", asError(error));
				report(asError(error));
				return Promise.reject(error);
			}
		},
		stopListening: (reason = "user") => closeSession(undefined, reason),
		interrupt(reason = "user") {
			if (session) {
				session.capture = null;
				session.detector.reset();
				session.preroll = [];
				session.prerollMs = 0;
				session.lastActivity = now();
			}
			voice.interrupt(reason);
			refresh();
		},
		getSessionSnapshot: () => snapshot,
		getSnapshot: voice.getSnapshot,
		getPhase: voice.getPhase,
		getIdentity: voice.getIdentity,
		subscribe(listener) {
			if (disposed) return () => {};
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			closeSession(undefined, "shutdown");
			unsubscribe();
			voice.dispose();
			listeners.clear();
		},
	};
}
