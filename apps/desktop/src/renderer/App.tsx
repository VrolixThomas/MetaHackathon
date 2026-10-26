import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentPanel } from "./review/AgentPanel";
import { DiffView } from "./review/DiffView";
import { Settings } from "./review/Settings";
import { Sidebar } from "./review/Sidebar";
import { createCaptureGate } from "./review/capture-gate";
import { useReview } from "./review/controller";
import { useReviewKeyboard } from "./review/keyboard";
import { connectAvailableRuntime } from "./review/runtime-bridge";
import { useServices } from "./review/services";

export function App() {
	useEffect(connectAvailableRuntime, []);
	const [settings, setSettings] = useState(false);
	const voice = useServices((s) => s.voice);
	const [voiceStatus, setVoiceStatus] = useState("Voice not connected");
	const { status, announce } = useReview();
	const closeSettings = useCallback(() => setSettings(false), []);
	const capture = useMemo(() => createCaptureGate(voice, announce), [voice, announce]);
	const startCapture = useCallback(() => capture.press(), [capture]);
	const endCapture = useCallback(() => {
		void capture.release();
	}, [capture]);
	useEffect(() => {
		const hidden = () => {
			if (document.hidden) endCapture();
		};
		window.addEventListener("blur", endCapture);
		document.addEventListener("visibilitychange", hidden);
		return () => {
			endCapture();
			window.removeEventListener("blur", endCapture);
			document.removeEventListener("visibilitychange", hidden);
		};
	}, [endCapture]);
	useEffect(() => {
		if (settings) endCapture();
	}, [settings, endCapture]);
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
