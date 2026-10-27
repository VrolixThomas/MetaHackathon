import { useStore } from "zustand";
import type { ConversationController } from "./controller";

export function VoiceBar({ controller }: { controller: ConversationController }) {
	const state = useStore(controller.store);
	const sessionOpen = state.handsFree || state.handsFreeStarting;
	const running = ["connecting", "listening", "transcribing", "thinking", "speaking"].includes(
		state.phase
	);
	const replying = !!state.active && ["transcribing", "thinking", "speaking"].includes(state.phase);
	const voiceReady = state.voice?.phase === "ready";
	const status = state.handsFreeStarting
		? "Starting microphone…"
		: running
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
			: state.handsFree
				? "Listening…"
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
		<footer
			className="voice-bar"
			aria-label="Voice controls"
			data-hands-free={state.handsFree}
			data-hands-free-starting={state.handsFreeStarting}
		>
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
					className={`talk-button ${sessionOpen ? "active" : ""}`}
					data-testid="voice-control"
					aria-label={sessionOpen ? "End conversation" : "Start conversation"}
					aria-pressed={sessionOpen}
					onClick={controller.toggleConversation}
				>
					<span aria-hidden="true">{sessionOpen ? "■" : "●"}</span>
					{sessionOpen ? "End conversation" : "Start conversation"}
				</button>
				<span
					className={`hands-free-indicator ${sessionOpen ? "enabled" : ""}`}
					data-testid="hands-free-status"
				>
					<span aria-hidden="true" className="microphone-indicator" />
					{state.handsFreeStarting
						? "Hands-free starting"
						: state.handsFree
							? "Hands-free on"
							: "Hands-free off"}
				</span>
				{replying && (
					<button
						type="button"
						className="quiet"
						data-testid="interrupt-reply"
						aria-label="Stop response"
						onClick={controller.interruptReply}
					>
						Stop response
					</button>
				)}
				<div className="voice-hint">
					<output aria-live="polite">{status}</output>
					<span>
						<kbd>⌘ ⇧ Space</kbd> to start / end
					</span>
				</div>
				{!sessionOpen &&
					!running &&
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
