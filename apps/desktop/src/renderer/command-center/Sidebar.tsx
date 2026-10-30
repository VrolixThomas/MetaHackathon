import { useStore } from "zustand";
import type { CenterSection, WorkspaceCommand } from "../../shared/contracts";
import type { WorkspaceController } from "../workspace/controller";
import { HubIcon } from "./HubIcon";
import type { HubController } from "./controller";
import {
	centerSections,
	isFinished,
	jobOutcomeLabel,
	jobReference,
	jobTitle,
	priorityItems,
	sectionCount,
	stateLabel,
} from "./model";

export function CommandSidebar({
	hub,
	workspace,
	conversationOpen,
	onConversation,
	onSettings,
}: {
	hub: HubController;
	workspace: WorkspaceController;
	conversationOpen: boolean;
	onConversation(): void;
	onSettings(): void;
}) {
	const { snapshot, busy, error } = useStore(hub.store);
	const canvasState = useStore(workspace.store).workspace;
	const canvas = canvasState?.canvases.find((item) => item.id === canvasState.primaryId);
	const section = canvasState?.centerSection ?? "home";
	const title = centerSections.find((item) => item.id === section)?.label;
	const selectedId =
		canvas?.kind === "center"
			? canvas.section === section
				? canvas.selectedId
				: undefined
			: section === "reviews" || section === "feedback"
				? canvasState?.review.prId
				: undefined;
	const command = (input: WorkspaceCommand) => void workspace.command(input);
	const select = (next: CenterSection, id?: string) =>
		command({ kind: "open-center", section: next, ...(id ? { selectedId: id } : {}) });
	const showRepositories = section === "reviews" || section === "feedback";
	const showJobs = section === "completed" || section === "activity";
	const queueKind = section === "feedback" ? "own" : "incoming";
	const source = section === "tickets" ? "linear" : showRepositories ? "github" : "worker";
	const sourceErrors = snapshot?.errors.filter((item) => item.source === source) ?? [];
	return (
		<aside className="command-navigation" aria-label="Executive workspace">
			<nav className="command-rail" aria-label="Workspace sections">
				<button
					type="button"
					className="hub-brand quiet"
					title="Open Home"
					aria-label="Open Home"
					onClick={() => select("home")}
				>
					m<span>·</span>
				</button>
				{centerSections.map((item) => {
					const count = snapshot ? sectionCount(snapshot, item.id) : null;
					const label = `${item.label}${count === null ? "" : ` (${count})`}`;
					return (
						<button
							type="button"
							className="quiet"
							key={item.id}
							title={label}
							aria-label={label}
							aria-current={section === item.id ? "page" : undefined}
							onClick={() =>
								item.id === "home"
									? select("home")
									: command({ kind: "browse-center", section: item.id })
							}
						>
							<HubIcon name={item.id} />
							{count !== null && (
								<span className="command-rail-count" aria-hidden="true">
									{count}
								</span>
							)}
						</button>
					);
				})}
				<div className="command-rail-bottom">
					<button
						type="button"
						className="quiet"
						title="Conversation and typing"
						aria-label="Conversation and typing"
						aria-controls="conversation-panel"
						aria-expanded={conversationOpen}
						onClick={onConversation}
					>
						<HubIcon name="conversation" />
					</button>
					<button
						type="button"
						className="quiet"
						title="Settings"
						aria-label="Settings"
						onClick={onSettings}
					>
						<HubIcon name="settings" />
					</button>
				</div>
			</nav>
			<div className="command-sidebar">
				<header>
					<strong>{title}</strong>
					<button
						type="button"
						className="quiet"
						title="Add repositories and Linear scopes"
						aria-label="Add repositories and Linear scopes"
						onClick={() => select("home", "connections")}
					>
						<HubIcon name="plus" />
					</button>
				</header>
				<section className="command-sidebar-scroll" key={section} aria-label={`${title} items`}>
					{!snapshot ? (
						<p className="hub-sidebar-empty" aria-live="polite">
							{error ? "Work is unavailable. Open Home to retry." : "Loading your workspace…"}
						</p>
					) : (
						<>
							{error && (
								<p className="hub-sidebar-empty" role="alert">
									{error}
								</p>
							)}
							{sourceErrors.map((item) => (
								<p
									className="hub-sidebar-empty"
									aria-live="polite"
									key={`${item.repositoryId ?? ""}:${item.message}`}
								>
									{item.message}
								</p>
							))}
							{section === "home" && (
								<>
									<div className="command-group-title">Up next</div>
									{priorityItems(snapshot).map((item) => (
										<button
											type="button"
											className="command-item quiet"
											key={item.id}
											onClick={() => select(item.section, item.selectedId)}
										>
											<span className="command-item-title">{item.title}</span>
											<span className="command-item-meta">{item.label}</span>
										</button>
									))}
									{!priorityItems(snapshot).length && (
										<p className="hub-sidebar-empty">
											No priorities to show. Open Home to see your brief and connections.
										</p>
									)}
								</>
							)}
							{showRepositories && (
								<>
									<div className="command-group-title">
										<span>
											{section === "feedback" ? "Your pull requests" : "Requested reviews"}
										</span>
										<span>{snapshot.reviews.filter((item) => item.kind === queueKind).length}</span>
									</div>
									{snapshot.repositories.map((repo) => {
										const items = snapshot.reviews.filter(
											(item) => item.repositoryId === repo.id && item.kind === queueKind
										);
										const failed = sourceErrors.some(
											(item) => !item.repositoryId || item.repositoryId === repo.id
										);
										return (
											<details className="command-repo" key={repo.id} open>
												<summary>
													<HubIcon name="repository" />
													<span title={repo.repository}>{repo.repository.split("/").at(-1)}</span>
													<span className="hub-count">{items.length}</span>
												</summary>
												{items.length ? (
													items.map((item) => (
														<button
															type="button"
															className="command-item quiet"
															key={item.pr.id}
															aria-current={selectedId === item.pr.id ? "true" : undefined}
															onClick={() =>
																queueKind === "own" || item.preparationStatus !== "ready"
																	? select(queueKind === "own" ? "feedback" : "reviews", item.pr.id)
																	: command({ kind: "show-review", prId: item.pr.id })
															}
														>
															<span className="command-item-title">{item.pr.title}</span>
															<span className="command-item-meta">
																#{item.pr.number} · {item.pr.author}
															</span>
															<span className="command-item-meta">
																{queueKind === "own"
																	? `${item.feedbackCount} feedback · ${stateLabel(item.reviewState)}`
																	: item.preparationStatus === "error"
																		? "Preparation needs retry"
																		: item.preparationStatus === "queued" ||
																				item.preparationStatus === "preparing"
																			? "Preparing review…"
																			: `${item.headBranch} → ${item.baseBranch}`}
															</span>
														</button>
													))
												) : (
													<p className="hub-sidebar-empty">
														{!snapshot.connections.github
															? "Connect GitHub to load pull requests."
															: failed
																? "Pull requests could not be refreshed."
																: queueKind === "own"
																	? "No own PRs in this repository."
																	: "No requested reviews."}
													</p>
												)}
											</details>
										);
									})}
									{(!snapshot.connections.github || !snapshot.repositories.length) && (
										<button
											type="button"
											className="hub-sidebar-empty quiet"
											onClick={() => select("home", "connections")}
										>
											{snapshot.connections.github
												? "Add a repository to follow reviews."
												: "Connect GitHub to refresh pull requests."}
										</button>
									)}
								</>
							)}
							{section === "tickets" && (
								<>
									<div className="command-group-title">Assigned to you</div>
									{!snapshot.tickets.some(
										(ticket) => !["completed", "canceled"].includes(ticket.state.type)
									) && (
										<p className="hub-sidebar-empty">
											{sourceErrors.length
												? "Assigned tickets could not be refreshed."
												: snapshot.connections.linear
													? "No assigned tickets in your selected scopes."
													: "Connect Linear to load your assigned tickets."}
										</p>
									)}
									{snapshot.tickets
										.filter((ticket) => !["completed", "canceled"].includes(ticket.state.type))
										.map((ticket) => (
											<button
												type="button"
												key={ticket.id}
												className="command-item quiet"
												aria-current={selectedId === ticket.id ? "true" : undefined}
												onClick={() => select("tickets", ticket.id)}
											>
												<span className="command-item-title">{ticket.title}</span>
												<span className="command-item-meta">
													{ticket.identifier} · {ticket.state.name}
												</span>
											</button>
										))}
								</>
							)}
							{showJobs && (
								<>
									<div className="command-group-title">
										<span>{section === "completed" ? "Saved outcomes" : "Workers"}</span>
										<span>
											{
												snapshot.jobs.filter(
													(job) => isFinished(job.state) === (section === "completed")
												).length
											}
										</span>
									</div>
									{snapshot.jobs
										.filter((job) => isFinished(job.state) === (section === "completed"))
										.map((job) => (
											<button
												type="button"
												className="command-item quiet"
												key={job.id}
												aria-current={selectedId === job.id ? "true" : undefined}
												onClick={() =>
													select(isFinished(job.state) ? "completed" : "activity", job.id)
												}
											>
												<span className="command-item-title">
													<span className={`hub-state-dot state-${job.state}`} />
													{jobTitle(job)}
												</span>
												<span className="command-item-meta">
													{jobReference(job)} · {jobOutcomeLabel(job)}
													{job.pendingDecisions
														? ` · ${job.pendingDecisions} decision${job.pendingDecisions === 1 ? "" : "s"}`
														: ""}
												</span>
											</button>
										))}
									{!snapshot.jobs.some(
										(job) => isFinished(job.state) === (section === "completed")
									) && (
										<p className="hub-sidebar-empty">
											{section === "completed"
												? "No saved outcomes yet."
												: "Start work from a ticket. Jobs and outcomes stay here."}
										</p>
									)}
									{section === "activity" && snapshot.notices.length > 0 && (
										<>
											<div className="command-group-title">Updates</div>
											{[...snapshot.notices]
												.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
												.map((notice) => (
													<article
														className="command-notice"
														key={notice.id}
														data-seen={!!notice.seenAt}
													>
														<strong>{notice.title}</strong>
														<p>{notice.detail}</p>
														<time dateTime={notice.createdAt}>
															{new Date(notice.createdAt).toLocaleString()}
														</time>
														<div className="hub-actions">
															{(notice.jobId || notice.prId) && (
																<button
																	type="button"
																	className="quiet"
																	aria-label={`Open update: ${notice.title}`}
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
																	aria-label={`Mark update read: ${notice.title}`}
																	onClick={() =>
																		void hub.operate({ kind: "seen-notice", noticeId: notice.id })
																	}
																>
																	Mark read
																</button>
															)}
														</div>
													</article>
												))}
										</>
									)}
								</>
							)}
						</>
					)}
				</section>
				<footer>
					<span className={busy ? "hub-pulse" : "hub-state-dot"} />
					{busy
						? "Updating…"
						: snapshot?.viewer.githubLogin
							? `@${snapshot.viewer.githubLogin}`
							: (snapshot?.viewer.linearName ?? "Your workspace")}
				</footer>
			</div>
		</aside>
	);
}
