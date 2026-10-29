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
	const section =
		canvas?.kind === "center" ? canvas.section : (canvasState?.centerSection ?? "home");
	const selectedId = canvas?.kind === "center" ? canvas.selectedId : canvasState?.review.prId;
	const command = (input: WorkspaceCommand) => void workspace.command(input);
	const select = (next: CenterSection, id?: string) =>
		command({ kind: "open-center", section: next, ...(id ? { selectedId: id } : {}) });
	const showRepositories = ["home", "reviews", "feedback"].includes(section);
	const showJobs = ["home", "completed", "activity"].includes(section);
	const queueKind = section === "feedback" ? "own" : "incoming";
	return (
		<aside className="command-navigation" aria-label="Executive workspace">
			<nav className="command-rail" aria-label="Workspace sections">
				<button
					type="button"
					className="hub-brand quiet"
					aria-label="Home"
					onClick={() => select("home")}
				>
					m<span>·</span>
				</button>
				{centerSections.map((item) => (
					<button
						type="button"
						className="quiet"
						key={item.id}
						title={item.label}
						aria-label={item.label}
						aria-current={section === item.id ? "page" : undefined}
						onClick={() => select(item.id)}
					>
						<HubIcon name={item.id} />
					</button>
				))}
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
					<strong>Workspace</strong>
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
				<nav className="command-sections" aria-label="Your work">
					{centerSections.map((item) => (
						<button
							type="button"
							key={item.id}
							className="quiet"
							aria-current={section === item.id ? "page" : undefined}
							onClick={() => select(item.id)}
						>
							<span>{item.label}</span>
							{snapshot && <span className="hub-count">{sectionCount(snapshot, item.id)}</span>}
						</button>
					))}
				</nav>
				<div className="command-sidebar-scroll">
					{!snapshot ? (
						<p className="hub-sidebar-empty" aria-live="polite">
							{error ? "Work is unavailable. Open Home to retry." : "Loading your workspace…"}
						</p>
					) : (
						<>
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
																	: `${item.headBranch} → ${item.baseBranch}`}
															</span>
														</button>
													))
												) : (
													<p className="hub-sidebar-empty">
														{queueKind === "own"
															? "No own PRs in this repository."
															: "No requested reviews."}
													</p>
												)}
											</details>
										);
									})}
									{!snapshot.repositories.length && (
										<button
											type="button"
											className="hub-sidebar-empty quiet"
											onClick={() => select("home", "connections")}
										>
											Add a repository to follow reviews.
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
											No assigned tickets in your selected scopes.
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
								</>
							)}
						</>
					)}
				</div>
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
