import type { VoiceAdapter } from "./services";

/** One owner for Space, keyboard button activation, pointer capture and focus-loss cleanup. */
export function createCaptureGate(voice: VoiceAdapter | null, onError: (message: string) => void) {
	let held = false;
	let capturing = false;
	let generation = 0;
	let pending = Promise.resolve();
	const enqueue = (operation: () => void | Promise<void>) => {
		pending = pending
			.then(operation)
			.catch(() => onError("Voice capture is unavailable. Check voice settings."));
		return pending;
	};
	return {
		press() {
			if (held) return;
			if (!voice) {
				onError("Voice capture is not connected. No microphone is active.");
				return;
			}
			held = true;
			const current = ++generation;
			if (voice.getPhase() === "speaking") {
				void Promise.resolve()
					.then(() => voice.interrupt())
					.catch(() => onError("Speech could not be interrupted."));
				return;
			}
			void enqueue(async () => {
				if (!held || current !== generation) return;
				capturing = true;
				await voice.beginCapture();
			});
		},
		release() {
			held = false;
			generation++;
			return enqueue(async () => {
				if (capturing && voice) {
					capturing = false;
					await voice.endCapture();
				}
			});
		},
		settled: () => pending,
	};
}
