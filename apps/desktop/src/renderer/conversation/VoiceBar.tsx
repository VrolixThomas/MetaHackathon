import { useRef } from "react";
import { useStore } from "zustand";
import type { ConversationController } from "./controller";

export function VoiceBar({ controller }: { controller: ConversationController }) {
	const state = useStore(controller.store);
	const keyHeld = useRef(false);
	const running = state.phase !== "idle";
	const voiceReady = state.voice?.phase === "ready";
	const status = running
		? {
				idle: "",
				connecting: "Connecting microphone…",
				listening: "Listening…",
				transcribing: "Transcribing…",
				thinking: "Thinking…",
				speaking: "Speaking…",
				complete: "",
				cancelled: "",
				error: "",
			}[state.phase]
		: state.config?.error
			? "Configuration needs attention"
			: state.configBusy
				? "Checking configuration…"
				: state.voice?.phase === "preparing"
					? "Preparing voice…"
					: voiceReady
						? "Voice ready"
						: "Voice needs configuration";
	return (
		<footer className="voice-bar" aria-label="Voice controls">
			{state.error && (
				<div className="voice-bar-error" role="alert">
					<span>{state.error}</span>
					<button
						type="button"
						className="quiet"
						aria-label="Dismiss error"
						onClick={controller.dismissError}
					>
						×
					</button>
				</div>
			)}
			<div className="voice-row">
				<button
					type="button"
					className={`talk-button ${running ? "active" : ""}`}
					data-testid="voice-control"
					aria-label={running ? "Stop" : "Hold to talk"}
					onPointerDown={(event) => {
						if (event.button !== 0) return;
						event.currentTarget.setPointerCapture(event.pointerId);
						if (running) controller.stop();
						else controller.press();
					}}
					onPointerUp={controller.release}
					onPointerCancel={controller.release}
					onLostPointerCapture={controller.release}
					onBlur={() => {
						keyHeld.current = false;
						controller.release();
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.code === "Space") {
							event.preventDefault();
							if (!event.repeat) {
								keyHeld.current = true;
								if (running) controller.stop();
								else controller.press();
							}
						}
					}}
					onKeyUp={(event) => {
						if (event.key === "Enter" || event.code === "Space") {
							event.preventDefault();
							keyHeld.current = false;
							controller.release();
						}
					}}
					onClick={(event) => {
						if (event.detail === 0 && !keyHeld.current) controller.toggle();
					}}
				>
					<span aria-hidden="true">{running ? "■" : "●"}</span>
					{running ? "Stop" : "Hold to talk"}
				</button>
				<div className="voice-hint">
					<output>{status}</output>
					<span>
						<kbd>⌘ ⇧ Space</kbd> to toggle
					</span>
				</div>
				{!running &&
					!voiceReady &&
					state.voice?.phase !== "preparing" &&
					state.config?.configured.meta &&
					state.config.configured.elevenlabs &&
					state.config.voiceId && (
						<button type="button" className="quiet" onClick={() => void controller.retryVoice()}>
							Retry voice
						</button>
					)}
			</div>
		</footer>
	);
}
