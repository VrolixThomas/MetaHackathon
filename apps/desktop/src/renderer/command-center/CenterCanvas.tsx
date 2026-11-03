import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type {
	Canvas,
	HubSnapshot,
	PullRequestFeedback,
	ReviewQueueItem,
	WorkspaceCommand,
} from "../../shared/contracts";
import type { DayController } from "../day/controller";
import { type PRFixController, PRFixView, PrepareSuggestedFixButton } from "../pr-fixes";
import { type SlackBrowseController, SlackConversationView } from "../slack";
import { DayWorkspace } from "../workspace/DayWorkspace";
import { MarkdownContent } from "../workspace/MarkdownContent";
import { Connections, HubConnections } from "./Connections";
import { JobView, TicketView } from "./WorkViews";
import type { HubController } from "./controller";
import { centerSections, priorityItems, sectionCount, stateLabel } from "./model";

type Command = (input: WorkspaceCommand) => void;

function SectionPrompt({
	section,
	snapshot,
	command,
}: {
	section: Exclude<Extract<Canvas, { kind: "center" }>["section"], "home">;
	snapshot: HubSnapshot;
	command: Command;
}) {
	const count = sectionCount(snapshot, section);
	const source =
		section === "tickets"
			? "linear"
			: section === "reviews" || section === "feedback"
				? "github"
				: "worker";
	const disconnected = source !== "worker" && !snapshot.connections[source];
	const failed = snapshot.errors.some((error) => error.source === source);
	const needsRepository = source === "github" && !snapshot.repositories.length;
	const emptyTitle = {
		slack: "Choose a Slack conversation",
		day: "No commitments yet",
		reviews: "No incoming review requests",
		feedback: "No own pull requests in your repositories",
		tickets: "No assigned tickets in these scopes",
		completed: "No saved outcomes yet",
		activity: "No coding jobs in progress",
		fixes: "Select a suggested fix",
	}[section];
	const item = source === "github" ? "pull request" : source === "linear" ? "ticket" : "job";
	let title = count ? `Select a ${item} in the sidebar` : emptyTitle;
	if (!count && failed) title = "This queue could not be refreshed";
	if (needsRepository) title = "Add a repository to follow pull requests";
	if (disconnected)
		title =
			source === "github"
				? "Connect GitHub to load pull requests"
				: "Connect Linear to load your tickets";
	const description = count
		? "Choose an item in the sidebar to inspect its details."
		: failed
			? "Check the connection message above and refresh to try again."
			: source === "github"
				? "Add repositories in Connections, then refresh to check for pull requests."
				: source === "linear"
					? "Choose the Linear teams and projects you want to follow in Connections."
					: "Choose a ticket from My tickets in the sidebar to start work. Jobs appear in Activity queue and saved outcomes in Completed work.";
	return (
		<div className="hub-empty">
			<h2>{title}</h2>
			<p>{description}</p>
			{(disconnected || needsRepository || (section === "tickets" && !count)) && (
				<button
					type="button"
					className="quiet"
					onClick={() =>
						command({ kind: "open-center", section: "home", selectedId: "connections" })
					}
				>
					Manage connections
				</button>
			)}
		</div>
	);
}

function OpenReview({
	item,
	hub,
	command,
}: { item: ReviewQueueItem; hub: HubController; command: Command }) {
	const { busy } = useStore(hub.store);
	const status = item.preparationStatus;
	return status === "error" ? (
		<button
			type="button"
			disabled={busy}
			onClick={() => void hub.operate({ kind: "retry-review", prId: item.pr.id })}
		>
			Retry review preparation
		</button>
	) : (
		<button
			type="button"
			disabled={status === "queued" || status === "preparing"}
			onClick={() => command({ kind: "show-review", prId: item.pr.id })}
		>
			{status === "queued" || status === "preparing"
				? "Preparing code review…"
				: "Open code review"}
		</button>
	);
}

function FeedbackView({
	hub,
	item,
	sequence,
	command,
	fixes,
}: {
	hub: HubController;
	item: ReviewQueueItem;
	sequence: number;
	command: Command;
	fixes?: PRFixController;
}) {
	const [feedback, setFeedback] = useState<{ prId: string; items: PullRequestFeedback[] } | null>(
		null
	);
	const [error, setError] = useState("");
	// biome-ignore lint/correctness/useExhaustiveDependencies: A newer hub sequence invalidates cached feedback.
	useEffect(() => {
		let current = true;
		setError("");
		void hub
			.feedback(item.pr.id)
			.then((items) => {
				if (current) setFeedback({ prId: item.pr.id, items });
			})
			.catch(() => {
				if (current) setError("Feedback could not be loaded. Refresh to try again.");
			});
		return () => {
			current = false;
		};
	}, [hub, item.pr.id, sequence]);
	return (
		<article className="hub-detail">
			<div className="hub-detail-meta">
				<span>
					{item.pr.repository} #{item.pr.number}
				</span>
				<span>{stateLabel(item.reviewState)}</span>
				<span>
					{item.headBranch} → {item.baseBranch}
				</span>
			</div>
			<h1>{item.pr.title}</h1>
			<p className="hub-muted">
				Feedback on your pull request · {item.feedbackCount} item
				{item.feedbackCount === 1 ? "" : "s"}
			</p>
			<div className="hub-actions">
				<OpenReview item={item} hub={hub} command={command} />
				<button
					type="button"
					className="quiet"
					onClick={() => command({ kind: "open-browser", url: item.pr.url })}
				>
					Open on GitHub ↗
				</button>
			</div>
			{error && (
				<p role="alert" className="hub-error">
					{error}
				</p>
			)}
			{feedback?.prId !== item.pr.id ? (
				<p aria-live="polite" className="hub-muted">
					{error ? "Feedback unavailable." : "Loading feedback…"}
				</p>
			) : feedback.items.length ? (
				<div className="hub-feedback-list">
					{feedback.items.map((entry) => (
						<article key={entry.id} className="hub-feedback-entry">
							<header>
								<strong>{entry.author}</strong>
								<span>
									{entry.kind}
									{entry.state ? ` · ${stateLabel(entry.state.toLowerCase())}` : ""}
								</span>
								<time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
							</header>
							{entry.path && (
								<button
									type="button"
									className="quiet hub-feedback-source"
									disabled={!entry.commitSha || !entry.line}
									onClick={() => {
										if (entry.path && entry.commitSha && entry.line)
											command({
												kind: "open-source",
												location: {
													repository: item.pr.repository,
													path: entry.path,
													commitSha: entry.commitSha,
													revision: "head",
													startLine: entry.startLine ?? entry.line,
													endLine: entry.line,
												},
											});
									}}
								>
									{entry.path}
									{entry.line ? `:${entry.line}` : ""}
								</button>
							)}
							<div className="canvas-markdown">
								<MarkdownContent
									markdown={entry.body}
									onOpenUrl={(url) => command({ kind: "open-browser", url })}
								/>
							</div>
							{entry.suggestion && (
								<details className="hub-disclosure">
									<summary>Suggested change</summary>
									<pre>{entry.suggestion}</pre>
								</details>
							)}
							{fixes && (
								<PrepareSuggestedFixButton controller={fixes} feedback={entry} command={command} />
							)}
							<button
								type="button"
								className="quiet"
								onClick={() => command({ kind: "open-browser", url: entry.url })}
							>
								View thread ↗
							</button>
						</article>
					))}
				</div>
			) : (
				<p className="hub-muted">No feedback is available on this PR.</p>
			)}
		</article>
	);
}

export function CenterCanvas({
	canvas,
	hub,
	day,
	slack,
	fixes,
	beforeNavigate,
	command,
	onSettings,
}: {
	canvas: Extract<Canvas, { kind: "center" }>;
	hub?: HubController;
	day?: DayController;
	slack?: SlackBrowseController;
	fixes?: PRFixController;
	beforeNavigate?(): void;
	command: Command;
	onSettings?(): void;
}) {
	if (canvas.section === "fixes")
		return fixes ? (
			<PRFixView
				controller={fixes}
				selectedId={canvas.selectedId}
				command={command}
				onNavigate={(selectedId) => {
					beforeNavigate?.();
					command({ kind: "open-center", section: "fixes", selectedId });
				}}
			/>
		) : (
			<p className="hub-muted">Suggested fixes are connecting…</p>
		);
	if (canvas.section === "slack")
		return slack ? (
			<SlackConversationView
				controller={slack}
				selectedId={canvas.selectedId}
				beforeNavigate={beforeNavigate}
				onNavigate={(target) =>
					command({ kind: "open-center", section: "slack", selectedId: target })
				}
			/>
		) : (
			<p className="hub-muted">Slack is connecting…</p>
		);
	if (canvas.section === "day")
		return day ? (
			<DayWorkspace day={day} hub={hub} itemId={canvas.selectedId} command={command} />
		) : (
			<p className="hub-muted">Your day is connecting…</p>
		);
	if (!hub)
		return (
			<div className="hub-center">
				<p className="hub-muted" aria-live="polite">
					The command center is connecting…
				</p>
			</div>
		);
	return (
		<ConnectedCenter
			canvas={canvas}
			hub={hub}
			command={command}
			onSettings={onSettings}
			fixes={fixes}
		/>
	);
}

function ConnectedCenter({
	canvas,
	hub,
	command,
	onSettings,
	fixes,
}: {
	canvas: Extract<Canvas, { kind: "center" }>;
	hub: HubController;
	command: Command;
	onSettings?(): void;
	fixes?: PRFixController;
}) {
	const { snapshot, busy, error } = useStore(hub.store);
	const title = centerSections.find((section) => section.id === canvas.section)?.label ?? "Home";
	const select = (section: typeof canvas.section, selectedId?: string) =>
		command({ kind: "open-center", section, ...(selectedId ? { selectedId } : {}) });
	const selectedJob = snapshot?.jobs.find((job) => job.id === canvas.selectedId);
	const selectedTicket = snapshot?.tickets.find((ticket) => ticket.id === canvas.selectedId);
	const selectedReview = snapshot?.reviews.find((item) => item.pr.id === canvas.selectedId);
	return (
		<div
			className="hub-center"
			data-center-section={canvas.section}
			data-selected-id={canvas.selectedId}
		>
			<header className="hub-center-header">
				<div>
					<span className="eyebrow">
						Your workspace{snapshot?.viewer.linearName ? ` / ${snapshot.viewer.linearName}` : ""}
					</span>
					<h1>{title}</h1>
				</div>
				<div className="hub-refresh">
					<span>
						{snapshot?.refreshedAt
							? `Updated ${new Date(snapshot.refreshedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
							: "Not refreshed yet"}
					</span>
					<button
						type="button"
						className="quiet"
						disabled={busy || snapshot?.refreshing}
						onClick={() => void hub.operate({ kind: "refresh" })}
					>
						{busy || snapshot?.refreshing ? "Refreshing…" : "Refresh"}
					</button>
				</div>
			</header>
			{error && (
				<div className="hub-error" role="alert">
					{error}{" "}
					<button type="button" className="quiet" onClick={() => void hub.refresh()}>
						Retry
					</button>
				</div>
			)}
			{snapshot?.errors.map((item) => (
				<p
					className="hub-error"
					key={`${item.source}:${item.repositoryId ?? ""}:${item.message}`}
					aria-live="polite"
				>
					<strong>
						{item.source === "github" ? "GitHub" : item.source === "linear" ? "Linear" : "Worker"}
						{item.repositoryId
							? ` · ${snapshot.repositories.find((repo) => repo.id === item.repositoryId)?.repository ?? "Repository"}`
							: ""}
						:
					</strong>{" "}
					{item.message}
				</p>
			))}
			{!snapshot ? (
				<div className="hub-empty">
					<h2>{error ? "Your work is unavailable" : "Loading your work…"}</h2>
					<p>
						{error
							? "Check your connections and retry."
							: "Reading connected repositories, tickets, and saved jobs."}
					</p>
					{onSettings && (
						<button type="button" className="quiet" onClick={onSettings}>
							Open Settings
						</button>
					)}
				</div>
			) : selectedJob ? (
				<JobView
					key={selectedJob.id}
					hub={hub}
					id={selectedJob.id}
					sequence={snapshot.sequence}
					command={command}
				/>
			) : selectedTicket ? (
				<TicketView
					key={selectedTicket.id}
					hub={hub}
					id={selectedTicket.id}
					sequence={snapshot.sequence}
					command={command}
				/>
			) : selectedReview ? (
				selectedReview.kind === "own" ? (
					<FeedbackView
						key={selectedReview.pr.id}
						hub={hub}
						item={selectedReview}
						sequence={snapshot.sequence}
						command={command}
						fixes={fixes}
					/>
				) : (
					<article className="hub-detail">
						<span className="eyebrow">
							Requested review · {selectedReview.pr.repository} #{selectedReview.pr.number}
						</span>
						<h1>{selectedReview.pr.title}</h1>
						<p className="hub-muted">
							{selectedReview.pr.author} · {selectedReview.headBranch} → {selectedReview.baseBranch}
						</p>
						<OpenReview item={selectedReview} hub={hub} command={command} />
					</article>
				)
			) : canvas.selectedId && canvas.selectedId !== "connections" ? (
				<div className="hub-empty">
					<h2>This item is no longer in your workspace.</h2>
					<p>Refresh or select another item in the sidebar.</p>
				</div>
			) : canvas.section === "home" ? (
				<>
					{canvas.selectedId === "connections" ? (
						<Connections hub={hub} onSettings={onSettings} />
					) : (
						<>
							<section className="hub-home-intro">
								<span className="hub-home-mark" aria-hidden="true">
									✦
								</span>
								<h2>Your priority brief</h2>
								<p>Decisions, reviews, and work ready for your attention.</p>
							</section>
							<section className="hub-priorities">
								<div className="hub-section-heading">
									<h2>Up next</h2>
									<button
										type="button"
										className="quiet"
										onClick={() => select("home", "connections")}
									>
										Manage connections
									</button>
								</div>
								{priorityItems(snapshot).length ? (
									priorityItems(snapshot).map((item) => (
										<button
											type="button"
											className={`hub-priority quiet tone-${item.tone}`}
											key={item.id}
											onClick={() => select(item.section, item.selectedId)}
										>
											<span className="hub-priority-label">{item.label}</span>
											<strong>{item.title}</strong>
											<span>{item.detail}</span>
											<span className="hub-priority-arrow" aria-hidden="true">
												↗
											</span>
										</button>
									))
								) : (
									<div className="hub-empty">
										<h2>
											{!snapshot.repositories.length
												? "Bring your work into view"
												: "Nothing needs your attention right now"}
										</h2>
										<p>
											{!snapshot.repositories.length
												? "Add repositories and Linear scopes to build a brief from your real work."
												: "Requested reviews, feedback, assigned tickets, and saved jobs will appear here."}
										</p>
										<button
											type="button"
											className="quiet"
											onClick={() => select("home", "connections")}
										>
											Connect repositories and Linear
										</button>
									</div>
								)}
							</section>
							<HubConnections hub={hub} onSettings={onSettings} />
						</>
					)}
				</>
			) : (
				<SectionPrompt section={canvas.section} snapshot={snapshot} command={command} />
			)}
		</div>
	);
}
