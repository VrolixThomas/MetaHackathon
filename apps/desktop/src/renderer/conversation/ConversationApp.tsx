import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { ReviewInbox } from "../prepared/Inbox";
import type { PreparedController } from "../prepared/controller";
import type { ConversationController } from "./controller";

function Configuration({
	controller,
	onClose,
}: { controller: ConversationController; onClose(): void }) {
	const state = useStore(controller.store);
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const previous = document.activeElement;
		dialog.current?.showModal();
		return () => {
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, []);
	const microphone = state.config?.microphone;
	return (
		<dialog
			className="configuration"
			ref={dialog}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			aria-labelledby="configuration-title"
		>
			<header>
				<h2 id="configuration-title">Configuration</h2>
				<button type="button" className="quiet" aria-label="Close configuration" onClick={onClose}>
					Close
				</button>
			</header>
			<p>Credentials stay in your local configuration file.</p>
			<code className="env-path" data-testid="env-path">
				{state.config?.envPath ??
					state.envPath ??
					(state.configBusy
						? "Loading configuration path…"
						: "Path unavailable. Use Open configuration.")}
			</code>
			<div className="configuration-actions">
				<button type="button" onClick={() => void controller.openEnv()}>
					Open configuration
				</button>
				<button
					type="button"
					disabled={state.configBusy}
					onClick={() => void controller.configure(true)}
				>
					{state.configBusy ? "Reloading…" : "Reload"}
				</button>
			</div>
			<dl className="configuration-status">
				{(["meta", "elevenlabs", "github"] as const).map((key) => (
					<div key={key}>
						<dt>{{ meta: "Meta", elevenlabs: "ElevenLabs", github: "GitHub (optional)" }[key]}</dt>
						<dd>
							{state.config
								? state.config.configured[key]
									? "Configured"
									: "Not configured"
								: "Checking…"}
						</dd>
					</div>
				))}
				<div>
					<dt>Voice ID</dt>
					<dd>{state.config?.voiceId ? "Configured" : "Not configured"}</dd>
				</div>
				<div>
					<dt>Microphone</dt>
					<dd data-testid="microphone-status">
						{microphone
							? {
									"not-determined": "Not requested",
									granted: "Allowed",
									denied: "Denied by macOS",
									restricted: "Restricted by macOS",
									unknown: "Unknown",
								}[microphone]
							: "Checking…"}
					</dd>
				</div>
			</dl>
			{microphone !== "granted" && (
				<button type="button" onClick={() => void controller.requestMicrophone()}>
					Request microphone access
				</button>
			)}
			<p className="small">
				Voice starts automatically when Meta, ElevenLabs and a voice ID are configured. After
				editing the file, choose Reload.
			</p>
			{(state.config?.error || state.error) && (
				<p className="inline-error" role="alert">
					{state.config?.error || state.error}
				</p>
			)}
		</dialog>
	);
}

export function ConversationApp({
	controller,
	reviews,
}: { controller: ConversationController; reviews: PreparedController }) {
	const state = useStore(controller.store);
	const [sidebar, setSidebar] = useState(false);
	const [configuration, setConfiguration] = useState(false);
	const [draft, setDraft] = useState("");
	const scroll = useRef<HTMLDivElement>(null);
	const keyHeld = useRef(false);
	const last = state.exchanges.at(-1);
	useEffect(() => {
		if ((last?.question || last?.answer) && scroll.current)
			scroll.current.scrollTop = scroll.current.scrollHeight;
	}, [last?.question, last?.answer]);
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
		<div className="conversation-app">
			<header className="app-header">
				<div className="app-title">
					<span className="app-symbol" aria-hidden="true">
						◌
					</span>
					<strong>Conversation</strong>
				</div>
				<nav aria-label="App">
					<button
						type="button"
						aria-expanded={sidebar}
						onClick={() => {
							setSidebar(!sidebar);
							if (!sidebar) void reviews.poll();
						}}
					>
						Repository
					</button>
					<button
						type="button"
						data-testid="configuration-toggle"
						onClick={() => {
							setConfiguration(true);
						}}
					>
						Configuration
					</button>
				</nav>
			</header>
			<div className="conversation-layout">
				{sidebar && (
					<ReviewInbox
						controller={reviews}
						onSelect={(detail) => void controller.selectPR(detail.pr)}
						onClose={() => setSidebar(false)}
					/>
				)}
				<main
					className="conversation-main"
					data-session-id={controller.sessionId}
					data-turn-id={state.active?.turnId ?? last?.turnId}
					data-generation={state.active?.generation ?? last?.generation}
					data-request-id={last?.requestId}
					data-conversation-state={state.phase}
				>
					{state.selected && (
						<div className="selected-context">
							<span>
								PR context · {state.selected.pr.repository} #{state.selected.pr.number}
								{state.selected.truncated ? " · Limited context" : ""}
							</span>
							<button
								type="button"
								className="quiet"
								aria-label="Remove PR context"
								onClick={() => void controller.selectPR(null)}
							>
								×
							</button>
						</div>
					)}
					<div className="conversation-scroll" ref={scroll} aria-label="Conversation messages">
						{!state.exchanges.length && (
							<div className="conversation-empty">
								<span className="eyebrow">A place to think out loud</span>
								<h1>Start a conversation.</h1>
								<p>Talk or type. Add a pull request when you need it.</p>
							</div>
						)}
						<div className="messages">
							{state.exchanges.map((entry) => (
								<article
									className="exchange"
									key={entry.turnId}
									data-turn-id={entry.turnId}
									data-phase={entry.phase}
								>
									<div className="user-message">
										<span className="message-label">You</span>
										<p>
											{entry.question ||
												(entry.phase === "cancelled" ? "Voice capture stopped" : "Listening…")}
										</p>
									</div>
									{entry.answer && (
										<div className="assistant-message">
											<span className="message-label">Assistant</span>
											<p>{entry.answer}</p>
										</div>
									)}
									{entry.phase === "cancelled" && <span className="message-state">Stopped</span>}
									{entry.phase === "error" && (
										<span className="message-state">Reply unavailable</span>
									)}
								</article>
							))}
						</div>
					</div>
					<div className="conversation-controls">
						{state.error && (
							<div className="conversation-error" role="alert">
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
									<button
										type="button"
										className="quiet"
										onClick={() => void controller.retryVoice()}
									>
										Retry voice
									</button>
								)}
						</div>
						<form
							className="composer"
							onSubmit={(event) => {
								event.preventDefault();
								if (!draft.trim()) return;
								void controller.submit(draft);
								setDraft("");
							}}
						>
							<textarea
								name="question"
								aria-label="Message"
								placeholder="Type a message…"
								value={draft}
								rows={2}
								maxLength={32000}
								onChange={(event) => setDraft(event.currentTarget.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
										event.preventDefault();
										event.currentTarget.form?.requestSubmit();
									}
								}}
							/>
							<button type="submit" aria-label="Send message" disabled={!draft.trim()}>
								Send <span aria-hidden="true">↑</span>
							</button>
						</form>
					</div>
				</main>
			</div>
			{configuration && (
				<Configuration controller={controller} onClose={() => setConfiguration(false)} />
			)}
		</div>
	);
}
