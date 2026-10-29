import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type {
	Canvas,
	PullRequestFeedback,
	ReviewQueueItem,
	WorkspaceCommand,
} from "../../shared/contracts";
import { MarkdownContent } from "../workspace/MarkdownContent";
import { Connections, HubConnections } from "./Connections";
import { JobView, TicketView } from "./WorkViews";
import type { HubController } from "./controller";
import {
	centerSections,
	isFinished,
	jobReference,
	jobTitle,
	priorityItems,
	priorityLabel,
	sectionCount,
	stateLabel,
} from "./model";

type Command = (input: WorkspaceCommand) => void;

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
}: { hub: HubController; item: ReviewQueueItem; sequence: number; command: Command }) {
	const busy = useStore(hub.store).busy;
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
								<>
									<details className="hub-disclosure">
										<summary>Suggested change</summary>
										<pre>{entry.suggestion}</pre>
									</details>
									<button
										type="button"
										disabled={busy}
										onClick={() => {
											void hub
												.operate({
													kind: "start-feedback-work",
													prId: item.pr.id,
													feedbackId: entry.id,
												})
												.then((result) => {
													if (result?.jobId)
														command({
															kind: "open-center",
															section: "activity",
															selectedId: result.jobId,
														});
												});
										}}
									>
										Start suggestion fix
									</button>
								</>
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
	command,
	onSettings,
}: {
	canvas: Extract<Canvas, { kind: "center" }>;
	hub?: HubController;
	command: Command;
	onSettings?(): void;
}) {
	if (!hub)
		return (
			<div className="hub-center">
				<p className="hub-muted" aria-live="polite">
					The command center is connecting…
				</p>
			</div>
		);
	return <ConnectedCenter canvas={canvas} hub={hub} command={command} onSettings={onSettings} />;
}

function ConnectedCenter({
	canvas,
	hub,
	command,
	onSettings,
}: {
	canvas: Extract<Canvas, { kind: "center" }>;
	hub: HubController;
	command: Command;
	onSettings?(): void;
}) {
	const { snapshot, busy, error } = useStore(hub.store);
	const title = centerSections.find((section) => section.id === canvas.section)?.label ?? "Home";
	const select = (section: typeof canvas.section, selectedId?: string) =>
		command({ kind: "open-center", section, ...(selectedId ? { selectedId } : {}) });
	const selectedJob = snapshot?.jobs.find((job) => job.id === canvas.selectedId);
	const selectedTicket = snapshot?.tickets.find((ticket) => ticket.id === canvas.selectedId);
	const selectedReview = snapshot?.reviews.find((item) => item.pr.id === canvas.selectedId);
	const detail = selectedJob || selectedTicket || selectedReview;
	const jobs =
		snapshot?.jobs.filter((job) => isFinished(job.state) === (canvas.section === "completed")) ??
		[];
	const reviews =
		snapshot?.reviews.filter(
			(item) => item.kind === (canvas.section === "feedback" ? "own" : "incoming")
		) ?? [];
	const tickets =
		snapshot?.tickets
			.filter((ticket) => !["completed", "canceled"].includes(ticket.state.type))
			.sort((a, b) => (a.priority || 5) - (b.priority || 5)) ?? [];
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
					<h1>
						{detail ? (
							<button
								type="button"
								className="quiet hub-back"
								onClick={() => select(canvas.section)}
							>
								← {title}
							</button>
						) : (
							title
						)}
					</h1>
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
					<p>Refresh or return to {title.toLowerCase()} to choose an available item.</p>
					<button type="button" className="quiet" onClick={() => select(canvas.section)}>
						Back to {title}
					</button>
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
							<div className="hub-metrics">
								{(["reviews", "feedback", "tickets", "activity"] as const).map((section) => (
									<button
										type="button"
										className="quiet"
										key={section}
										onClick={() => select(section)}
									>
										<strong>{sectionCount(snapshot, section)}</strong>
										<span>{centerSections.find((item) => item.id === section)?.label}</span>
									</button>
								))}
							</div>
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
			) : canvas.section === "reviews" || canvas.section === "feedback" ? (
				<>
					<p className="hub-section-intro">
						{canvas.section === "reviews"
							? "Pull requests where your review is requested."
							: "Your pull requests and the feedback people have left."}
					</p>
					{snapshot.repositories.map((repo) => (
						<section className="hub-repo-section" key={repo.id}>
							<h2>
								{repo.repository}
								<span className="hub-count">
									{reviews.filter((item) => item.repositoryId === repo.id).length}
								</span>
							</h2>
							{reviews
								.filter((item) => item.repositoryId === repo.id)
								.map((item) => (
									<button
										type="button"
										className="hub-list-row quiet"
										key={item.pr.id}
										onClick={() =>
											canvas.section === "reviews" && item.preparationStatus === "ready"
												? command({ kind: "show-review", prId: item.pr.id })
												: select(canvas.section, item.pr.id)
										}
									>
										<div>
											<strong>{item.pr.title}</strong>
											<small>
												#{item.pr.number} · {item.pr.author} · {item.headBranch} → {item.baseBranch}
											</small>
										</div>
										<span className="hub-status">
											{canvas.section === "feedback"
												? `${item.feedbackCount} feedback`
												: item.preparationStatus === "error"
													? "Preparation needs retry"
													: item.preparationStatus && item.preparationStatus !== "ready"
														? "Preparing review…"
														: item.draft
															? "Draft"
															: "Review requested"}
										</span>
									</button>
								))}
						</section>
					))}
					{!reviews.length && (
						<div className="hub-empty">
							<h2>
								{snapshot.connections.github
									? canvas.section === "reviews"
										? "No incoming review requests"
										: "No own pull requests in your repositories"
									: "Connect GitHub to load pull requests"}
							</h2>
							<p>
								{snapshot.repositories.length
									? "Refresh to check your connected repositories."
									: "Add a repository to get started."}
							</p>
							<button type="button" className="quiet" onClick={() => select("home", "connections")}>
								Manage repositories
							</button>
						</div>
					)}
				</>
			) : canvas.section === "tickets" ? (
				<>
					<p className="hub-section-intro">
						Tickets assigned to you in your selected Linear teams and projects.
					</p>
					{tickets.map((ticket) => (
						<button
							type="button"
							className="hub-list-row quiet"
							key={ticket.id}
							onClick={() => select("tickets", ticket.id)}
						>
							<span
								className={`hub-ticket-priority priority-${ticket.priority}`}
								title={priorityLabel(ticket.priority)}
								aria-label={priorityLabel(ticket.priority)}
							>
								{ticket.priority === 1 ? "!" : "▥"}
							</span>
							<div>
								<span className="hub-ticket-id">{ticket.identifier}</span>
								<strong>{ticket.title}</strong>
								<small>
									{ticket.teamName}
									{ticket.projectName ? ` / ${ticket.projectName}` : ""}
								</small>
							</div>
							<span className="hub-status">{ticket.state.name}</span>
						</button>
					))}
					{!tickets.length && (
						<div className="hub-empty">
							<h2>
								{snapshot.connections.linear
									? "No assigned tickets in these scopes"
									: "Connect Linear to load your tickets"}
							</h2>
							<p>Choose the teams and projects you want to follow.</p>
							<button type="button" className="quiet" onClick={() => select("home", "connections")}>
								Choose Linear scopes
							</button>
						</div>
					)}
				</>
			) : (
				<>
					<p className="hub-section-intro">
						{canvas.section === "completed"
							? "Saved worker outcomes and local changes, ready to inspect."
							: "Saved coding jobs, questions, and updates. Resume work when you are ready."}
					</p>
					{jobs.map((job) => (
						<button
							type="button"
							className="hub-list-row quiet"
							key={job.id}
							onClick={() => select(canvas.section, job.id)}
						>
							<span className={`hub-state-dot state-${job.state}`} />
							<div>
								<strong>{jobTitle(job)}</strong>
								<small>
									{jobReference(job)} · {job.repository} · {job.branch}
								</small>
							</div>
							<span className={`hub-status status-${job.state}`}>
								{job.pendingDecisions
									? `${job.pendingDecisions} decision${job.pendingDecisions === 1 ? "" : "s"}`
									: stateLabel(job.state)}
							</span>
						</button>
					))}
					{!jobs.length && (
						<div className="hub-empty">
							<h2>
								{canvas.section === "completed"
									? "No saved outcomes yet"
									: "No coding jobs in progress"}
							</h2>
							<p>
								Open a ticket, select its repository, and give a coding worker a clarified brief.
							</p>
							<button type="button" className="quiet" onClick={() => select("tickets")}>
								Open my tickets
							</button>
						</div>
					)}
					{canvas.section === "activity" && snapshot.notices.length > 0 && (
						<section className="hub-notices">
							<h2>Updates</h2>
							{[...snapshot.notices]
								.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
								.map((notice) => (
									<div className="hub-notice" key={notice.id} data-seen={!!notice.seenAt}>
										<div>
											<strong>{notice.title}</strong>
											<p>{notice.detail}</p>
											<time dateTime={notice.createdAt}>
												{new Date(notice.createdAt).toLocaleString()}
											</time>
										</div>
										<div className="hub-actions">
											{(notice.jobId || notice.prId) && (
												<button
													type="button"
													className="quiet"
													onClick={() => {
														if (notice.jobId) select("activity", notice.jobId);
														else if (notice.prId) select("feedback", notice.prId);
													}}
												>
													Open
												</button>
											)}
											{!notice.seenAt && (
												<button
													type="button"
													className="quiet"
													disabled={busy}
													onClick={() =>
														void hub.operate({ kind: "seen-notice", noticeId: notice.id })
													}
												>
													Mark read
												</button>
											)}
										</div>
									</div>
								))}
						</section>
					)}
				</>
			)}
		</div>
	);
}
