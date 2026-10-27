import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { ReviewInbox } from "../prepared/Inbox";
import { ReviewWorkspace } from "../prepared/ReviewWorkspace";
import type { PreparedController } from "../prepared/controller";
import { WorkSplit } from "../workspace/WorkSplit";
import type { LocalBrowserController } from "../workspace/local-browser";
import { VoiceBar } from "./VoiceBar";
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
	browser,
}: {
	controller: ConversationController;
	reviews: PreparedController;
	browser: LocalBrowserController;
}) {
	const state = useStore(controller.store);
	const prepared = useStore(reviews.store);
	const local = useStore(browser.store);
	const reviewOpen = prepared.screen.mode === "review";
	const [sidebar, setSidebar] = useState(false);
	const [configuration, setConfiguration] = useState(false);
	const [conversationOpen, setConversationOpen] = useState(false);
	const [previewPrompt, setPreviewPrompt] = useState(false);
	const [url, setUrl] = useState("");
	const [draft, setDraft] = useState("");
	const scroll = useRef<HTMLDivElement>(null);
	const composer = useRef<HTMLTextAreaElement>(null);
	const conversationToggle = useRef<HTMLButtonElement>(null);
	const last = state.exchanges.at(-1);
	useEffect(() => {
		if (conversationOpen) composer.current?.focus();
	}, [conversationOpen]);
	useEffect(() => {
		if (conversationOpen && (last?.question || last?.answer) && scroll.current)
			scroll.current.scrollTop = scroll.current.scrollHeight;
	}, [conversationOpen, last?.question, last?.answer]);
	const openRepository = () => {
		setSidebar(true);
		void reviews.poll();
	};
	const closeConversation = () => {
		setConversationOpen(false);
		conversationToggle.current?.focus();
	};
	return (
		<div className="conversation-app review-first">
			<header className="app-header">
				<div className="app-title">
					<span className="app-symbol" aria-hidden="true">
						◌
					</span>
					<strong>Review</strong>
					{prepared.inbox?.repository && (
						<span className="header-repository">{prepared.inbox.repository}</span>
					)}
				</div>
				<nav aria-label="Workspace controls">
					<button
						type="button"
						aria-expanded={sidebar}
						onClick={() => {
							if (sidebar) setSidebar(false);
							else openRepository();
						}}
					>
						Repository
					</button>
					<button
						type="button"
						ref={conversationToggle}
						data-testid="conversation-toggle"
						aria-controls="conversation-panel"
						aria-expanded={conversationOpen}
						onClick={() => setConversationOpen(!conversationOpen)}
					>
						Conversation
					</button>
					<button
						type="button"
						data-testid="local-preview-toggle"
						aria-expanded={previewPrompt || !!local.page}
						onClick={() => setPreviewPrompt(!previewPrompt)}
					>
						Local preview
					</button>
					<button
						type="button"
						data-testid="configuration-toggle"
						onClick={() => setConfiguration(true)}
					>
						Configuration
					</button>
				</nav>
			</header>
			{previewPrompt && (
				<form
					className="open-local-preview"
					aria-label="Open local preview"
					onSubmit={(event) => {
						event.preventDefault();
						void browser.open(url).then(() => {
							if (browser.store.getState().page && !browser.store.getState().error)
								setPreviewPrompt(false);
						});
					}}
				>
					<label htmlFor="local-preview-url">Running local address</label>
					<input
						id="local-preview-url"
						name="local-preview-url"
						type="url"
						placeholder="http://localhost:3000"
						value={url}
						onChange={(event) => setUrl(event.currentTarget.value)}
						required
						spellCheck={false}
					/>
					<button type="submit" disabled={local.busy}>
						{local.busy ? "Opening…" : "Open"}
					</button>
					<button
						type="button"
						className="quiet"
						aria-label="Close preview address form"
						onClick={() => setPreviewPrompt(false)}
					>
						×
					</button>
					{local.error && <span role="alert">{local.error}</span>}
				</form>
			)}
			<div className="workspace-body">
				{sidebar && (
					<ReviewInbox
						controller={reviews}
						onSelect={(detail) => {
							setSidebar(false);
							void reviews.open(detail.pr.id);
						}}
						onClose={() => setSidebar(false)}
					/>
				)}
				<WorkSplit browser={local.page ? browser : undefined} obscured={configuration}>
					<main
						className={`conversation-main work-area ${reviewOpen ? "review-open" : ""}`}
						data-session-id={controller.sessionId}
						data-turn-id={state.active?.turnId ?? last?.turnId}
						data-generation={state.active?.generation ?? last?.generation}
						data-request-id={last?.requestId}
						data-conversation-state={state.phase}
					>
						<div className="primary-work" hidden={!reviewOpen && conversationOpen}>
							{reviewOpen ? (
								<ReviewWorkspace controller={reviews} onPause={() => controller.stop()} />
							) : (
								<div className="review-empty">
									<span className="eyebrow">Review workspace</span>
									<h1>Choose a pull request.</h1>
									<p>Open a repository to inspect its files and prepared reading order.</p>
									<div>
										<button type="button" onClick={openRepository}>
											Open repository
										</button>
										<button
											type="button"
											className="quiet"
											onClick={() => setConversationOpen(true)}
										>
											Type a question
										</button>
									</div>
									<p className="small">You can talk at any time.</p>
								</div>
							)}
						</div>
						<section
							id="conversation-panel"
							className="conversation-panel"
							aria-label="Conversation and typing"
							hidden={!conversationOpen}
						>
							<header className="conversation-panel-header">
								<strong>Conversation</strong>
								<button
									type="button"
									className="quiet"
									aria-label="Hide conversation"
									onClick={closeConversation}
								>
									×
								</button>
							</header>
							{state.selected && (
								<div className="selected-context">
									<span>
										PR context · {state.selected.pr.repository} #{state.selected.pr.number}
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
									<p className="conversation-note">
										Your conversation will appear here. Talk or type to begin.
									</p>
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
											{entry.phase === "cancelled" && (
												<span className="message-state">Stopped</span>
											)}
											{entry.phase === "error" && (
												<span className="message-state">Reply unavailable</span>
											)}
										</article>
									))}
								</div>
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
									ref={composer}
									name="question"
									aria-label="Message"
									placeholder="Type a message…"
									value={draft}
									rows={2}
									maxLength={32000}
									onChange={(event) => setDraft(event.currentTarget.value)}
									onKeyDown={(event) => {
										if (
											event.key === "Enter" &&
											!event.shiftKey &&
											!event.nativeEvent.isComposing
										) {
											event.preventDefault();
											event.currentTarget.form?.requestSubmit();
										}
									}}
								/>
								<button type="submit" aria-label="Send message" disabled={!draft.trim()}>
									Send <span aria-hidden="true">↑</span>
								</button>
							</form>
						</section>
					</main>
				</WorkSplit>
			</div>
			<VoiceBar controller={controller} />
			{configuration && (
				<Configuration controller={controller} onClose={() => setConfiguration(false)} />
			)}
		</div>
	);
}
