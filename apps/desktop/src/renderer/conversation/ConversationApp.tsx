import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { ReviewInbox } from "../prepared/Inbox";
import { ReviewWorkspace } from "../prepared/ReviewWorkspace";
import type { PreparedController } from "../prepared/controller";
import { WorkSplit } from "../workspace/WorkSplit";
import { WorkspaceDialog } from "../workspace/WorkspaceDialog";
import type { LocalBrowserController } from "../workspace/local-browser";
import { VoiceBar } from "./VoiceBar";
import type { ConversationController } from "./controller";

export function Configuration({
	controller,
	onClose,
	beforeOpen,
	onOpenError,
	returnFocus,
}: {
	controller: ConversationController;
	onClose(): void;
	beforeOpen?: () => Promise<void>;
	onOpenError?(): void;
	returnFocus?: RefObject<HTMLButtonElement | null>;
}) {
	const state = useStore(controller.store);
	const microphone = state.config?.microphone;
	const githubStatus = state.githubBusy
		? "Connecting…"
		: state.githubError
			? state.account
				? `Last account: @${state.account.login}`
				: "Connection unavailable"
			: state.account
				? `Connected as @${state.account.login}`
				: state.config?.configured.github
					? "Configured · account not checked"
					: "Not connected";
	return (
		<WorkspaceDialog
			id="configuration"
			title="Settings"
			position="center"
			className="configuration"
			onClose={onClose}
			beforeOpen={beforeOpen}
			onOpenError={onOpenError}
			returnFocus={returnFocus}
		>
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
							{key === "github" ? (
								<output data-testid="github-account-status">{githubStatus}</output>
							) : state.config ? (
								state.config.configured[key] ? (
									"Configured"
								) : (
									"Not configured"
								)
							) : (
								"Checking…"
							)}
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
			<div className="configuration-actions" aria-busy={state.githubBusy}>
				<button
					type="button"
					data-testid="github-connect"
					aria-describedby="github-connection-help"
					disabled={state.githubBusy}
					onClick={() => void controller.refreshGitHub(true)}
				>
					Connect GitHub
				</button>
				<span id="github-connection-help" className="small">
					Import your existing <code>gh</code> CLI sign-in.
				</span>
			</div>
			{state.githubError && (
				<p className="inline-error" role="alert">
					{state.githubError}
				</p>
			)}
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
		</WorkspaceDialog>
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
	const [overlay, setOverlay] = useState<
		"repository" | "more" | "preview" | "configuration" | null
	>(null);
	const [overlayError, setOverlayError] = useState("");
	const overlayFailed = () => {
		setOverlay(null);
		setOverlayError("Could not hide the local browser. Close it and try again.");
	};
	const [conversationOpen, setConversationOpen] = useState(false);
	const [url, setUrl] = useState("");
	const [draft, setDraft] = useState("");
	const scroll = useRef<HTMLDivElement>(null);
	const composer = useRef<HTMLTextAreaElement>(null);
	const moreToggle = useRef<HTMLButtonElement>(null);
	const repositoryToggle = useRef<HTMLButtonElement>(null);
	const hideNativePage = useCallback(async () => {
		if (browser.store.getState().page) await browser.present(null);
	}, [browser]);
	const identity = prepared.detail?.pr;
	const repository = identity?.repository ?? prepared.inbox?.repository;
	const closeOverlay = () => setOverlay(null);
	const last = state.exchanges.at(-1);
	useEffect(() => {
		if (conversationOpen) composer.current?.focus();
	}, [conversationOpen]);
	useEffect(() => {
		if (conversationOpen && (last?.question || last?.answer) && scroll.current)
			scroll.current.scrollTop = scroll.current.scrollHeight;
	}, [conversationOpen, last?.question, last?.answer]);
	const openRepository = () => {
		setOverlay("repository");
		void reviews.poll();
	};
	const closeConversation = () => {
		setConversationOpen(false);
		moreToggle.current?.focus();
	};
	return (
		<div className="conversation-app review-first">
			<header className="app-header">
				<button
					type="button"
					className="repository-identity quiet"
					ref={repositoryToggle}
					data-testid="repository-selector"
					aria-haspopup="dialog"
					aria-controls="repository-selector"
					aria-expanded={overlay === "repository"}
					aria-label={`Choose repository or pull request${repository ? `: ${repository}${identity ? ` #${identity.number}` : ""}` : ""}`}
					onClick={openRepository}
				>
					<span className="app-symbol" aria-hidden="true">
						◌
					</span>
					<span className="repository-identity-name">{repository ?? "Open repository"}</span>
					{identity && (
						<>
							<span className="identity-number">#{identity.number}</span>
							<span className="identity-title">{identity.title}</span>
						</>
					)}
					<span aria-hidden="true">⌄</span>
				</button>
				<button
					type="button"
					className="quiet more-toggle"
					ref={moreToggle}
					data-testid="workspace-more"
					aria-haspopup="dialog"
					aria-controls="workspace-more"
					aria-expanded={overlay === "more"}
					aria-label="More workspace options"
					onClick={() => setOverlay("more")}
				>
					More <span aria-hidden="true">···</span>
				</button>
			</header>
			{overlayError && (
				<div className="workspace-overlay-error" role="alert">
					<span>{overlayError}</span>
					<button
						type="button"
						className="quiet"
						aria-label="Dismiss workspace error"
						onClick={() => setOverlayError("")}
					>
						Close
					</button>
				</div>
			)}
			<div className="workspace-body">
				<WorkSplit browser={local.page ? browser : undefined} obscured={overlay !== null}>
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
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									closeConversation();
								}
							}}
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
			{overlay === "repository" && (
				<WorkspaceDialog
					id="repository-selector"
					title="Repositories and pull requests"
					position="left"
					onClose={closeOverlay}
					beforeOpen={hideNativePage}
					onOpenError={overlayFailed}
					returnFocus={repositoryToggle}
				>
					<ReviewInbox
						controller={reviews}
						onSelect={(detail) => {
							closeOverlay();
							void reviews.open(detail.pr.id);
						}}
					/>
				</WorkspaceDialog>
			)}
			{overlay === "more" && (
				<WorkspaceDialog
					id="workspace-more"
					title="Workspace options"
					className="workspace-options"
					onClose={closeOverlay}
					beforeOpen={hideNativePage}
					onOpenError={overlayFailed}
					returnFocus={moreToggle}
				>
					<button
						type="button"
						data-testid="conversation-toggle"
						aria-controls="conversation-panel"
						aria-expanded={conversationOpen}
						onClick={() => {
							closeOverlay();
							setConversationOpen(!conversationOpen);
						}}
					>
						{conversationOpen ? "Hide conversation and typing" : "Conversation and typing"}
					</button>
					<button
						type="button"
						data-testid="local-preview-toggle"
						aria-haspopup="dialog"
						onClick={() => setOverlay("preview")}
					>
						Open local preview
					</button>
					<button
						type="button"
						data-testid="configuration-toggle"
						aria-haspopup="dialog"
						onClick={() => setOverlay("configuration")}
					>
						Settings
					</button>
				</WorkspaceDialog>
			)}
			{overlay === "preview" && (
				<WorkspaceDialog
					id="local-preview-prompt"
					title="Local preview"
					onClose={closeOverlay}
					beforeOpen={hideNativePage}
					onOpenError={overlayFailed}
					returnFocus={moreToggle}
				>
					<form
						className="open-local-preview"
						aria-label="Open local preview"
						noValidate
						onSubmit={(event) => {
							event.preventDefault();
							void browser.open(url).then(() => {
								if (browser.store.getState().page && !browser.store.getState().error)
									setOverlay((current) => (current === "preview" ? null : current));
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
							spellCheck={false}
						/>
						<button type="submit" disabled={local.busy}>
							{local.busy ? "Opening…" : "Open"}
						</button>
						{local.error && <span role="alert">{local.error}</span>}
					</form>
				</WorkspaceDialog>
			)}
			{overlay === "configuration" && (
				<Configuration
					controller={controller}
					onClose={closeOverlay}
					beforeOpen={hideNativePage}
					onOpenError={overlayFailed}
					returnFocus={moreToggle}
				/>
			)}
		</div>
	);
}
