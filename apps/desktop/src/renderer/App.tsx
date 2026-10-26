import { useCallback, useEffect, useState } from "react";
import { AgentPanel } from "./review/AgentPanel";
import { DiffView } from "./review/DiffView";
import { Settings } from "./review/Settings";
import { Sidebar } from "./review/Sidebar";
import { useReview } from "./review/controller";
import { useReviewKeyboard } from "./review/keyboard";
import { useServices } from "./review/services";

export function App() {
	const [settings, setSettings] = useState(false);
	const voice = useServices((s) => s.voice);
	const [voiceStatus, setVoiceStatus] = useState("Voice not connected");
	const { status, announce } = useReview();
	const closeSettings = useCallback(() => setSettings(false), []);
	const startCapture = useCallback(() => {
		if (!voice) {
			announce("Voice capture is not connected. No microphone is active.");
			return;
		}
		void Promise.resolve(
			voice.getPhase() === "speaking" ? voice.interrupt() : voice.beginCapture()
		).catch(() => announce("Voice capture is unavailable. Check voice settings."));
	}, [voice, announce]);
	const endCapture = useCallback(() => {
		if (voice)
			void Promise.resolve(voice.endCapture()).catch(() =>
				announce("Could not finish voice capture.")
			);
	}, [voice, announce]);
	useEffect(() => {
		if (!voice) {
			setVoiceStatus("Voice not connected");
			return;
		}
		const update = () => {
			const phase = voice.getPhase();
			setVoiceStatus(
				phase === "idle" ? "Ready to talk" : `${phase.charAt(0).toUpperCase()}${phase.slice(1)}`
			);
		};
		update();
		return voice.subscribe(update);
	}, [voice]);
	useReviewKeyboard({ modalOpen: settings, closeModal: closeSettings, startCapture, endCapture });
	useEffect(() => {
		if (!status) return;
		const timer = setTimeout(() => announce(""), 7000);
		return () => clearTimeout(timer);
	}, [status, announce]);
	return (
		<div className="app-shell">
			<Sidebar
				onSettings={() => setSettings(true)}
				voiceStatus={voiceStatus}
				onTalkStart={startCapture}
				onTalkEnd={endCapture}
			/>
			<div className="workspace">
				<DiffView />
				<AgentPanel />
			</div>
			{settings && <Settings onClose={closeSettings} />}
			{status && (
				<output className="toast">
					{status}
					<button type="button" aria-label="Dismiss notification" onClick={() => announce("")}>
						×
					</button>
				</output>
			)}
		</div>
	);
}
