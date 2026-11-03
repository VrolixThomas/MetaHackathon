import { useStore } from "zustand";
import type { CenterSection, WorkspaceCommand } from "../../shared/contracts";
import { BrandMark } from "../brand/Brand";
import { DayQueue } from "../day";
import type { DayController } from "../day/controller";
import { type PRFixController, PRFixList } from "../pr-fixes";
import { type SlackBrowseController, SlackConversationList } from "../slack";
import type { WorkspaceController } from "../workspace/controller";
import { HubIcon } from "./HubIcon";
import type { HubController } from "./controller";
import {
	centerSections,
	fixesCenterSection,
	isFinished,
	jobOutcomeLabel,
	jobReference,
	jobTitle,
	sectionCount,
	stateLabel,
} from "./model";

export function CommandSidebar({
	hub,
	day,
	slack,
	fixes,
	workspace,
	conversationOpen,
	onConversation,
	onSettings,
}: {
	hub: HubController;
	day?: DayController;
	slack?: SlackBrowseController;
	fixes?: PRFixController;
	workspace: WorkspaceController;
	conversationOpen: boolean;
	onConversation(): void;
	onSettings(): void;
}) {
	const { snapshot, busy, error } = useStore(hub.store);
	const workspaceState = useStore(workspace.store);
	const canvasState = workspaceState.workspace;
	const recentCanvases = [
		...new Map(
			[
				...(canvasState?.canvases ?? []).filter((item) =>
					["document", "source", "flow", "visual"].includes(item.kind)
				),
				...(workspaceState.observation?.savedCanvases ?? []),
			].map((item) => [item.id, item])
		).values(),
	]
		.slice(-12)
		.reverse();
	const canvas = canvasState?.canvases.find((item) => item.id === canvasState.primaryId);
	const section = canvasState?.centerSection ?? "home";
	const title =
		[...centerSections, fixesCenterSection].find((item) => item.id === section)?.label ??
		(section === "slack" ? "Slack" : "Workspace");
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
					title="MuseFocus · Open Home"
					aria-label="Open Home"
					onClick={() => select("home")}
				>
					<BrandMark size={32} />
				</button>
				{centerSections
					.filter((item) => !["feedback", "activity"].includes(item.id))
					.filter((item) => (item.id !== "day" || day) && (item.id !== "slack" || slack))
					.map((item) => {
						if (item.id === "slack" && slack)
							return (
								<SlackRailButton
									key="slack"
									controller={slack}
									selected={section === "slack"}
									onBrowse={() => select("slack")}
								/>
							);
						if (item.id === "day" && day)
							return (
								<DayRailButton
									key="day"
									day={day}
									selected={section === "day"}
									onBrowse={() => select("day")}
								/>
							);
						const count = snapshot ? sectionCount(snapshot, item.id) : null;
						const railLabel =
							item.id === "reviews"
								? "Reviews"
								: item.id === "completed"
									? "Work"
									: item.id === "tickets"
										? "Tickets"
										: item.label;
						const label = `${railLabel}${count === null ? "" : ` (${count})`}`;
						return (
							<button
								type="button"
								className="quiet"
								key={item.id}
								title={label}
								aria-label={label}
								aria-current={
									section === item.id ||
									(item.id === "reviews" && ["feedback", "fixes"].includes(section)) ||
									(item.id === "completed" && section === "activity")
										? "page"
										: undefined
								}
								onClick={() => select(item.id)}
							>
								<HubIcon name={item.id} />
								<span className="command-rail-label">{railLabel}</span>
								{count !== null && count > 0 && (
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
					{section !== "fixes" && (
						<button
							type="button"
							className="quiet"
							title={
								section === "slack"
									? "Slack connection settings"
									: "Add repositories and Linear scopes"
							}
							aria-label={
								section === "slack"
									? "Slack connection settings"
									: "Add repositories and Linear scopes"
							}
							onClick={() => (section === "slack" ? onSettings() : select("home", "connections"))}
						>
							<HubIcon name={section === "slack" ? "settings" : "plus"} />
						</button>
					)}
				</header>
				{["reviews", "feedback", "fixes"].includes(section) && (
					<nav className="command-subsections" aria-label="Review queues">
						{(
							[
								["reviews", "Requested"],
								["feedback", "My PRs"],
								...(fixes ? [["fixes", "Fixes"]] : []),
							] as [CenterSection, string][]
						).map(([id, label]) => (
							<button
								type="button"
								className="quiet"
								key={id}
								aria-current={section === id ? "page" : undefined}
								onClick={() => select(id)}
							>
								{label}
							</button>
						))}
					</nav>
				)}
				{showJobs && (
					<nav className="command-subsections" aria-label="Work queues">
						{(
							[
								["activity", "In progress"],
								["completed", "Completed"],
							] as [CenterSection, string][]
						).map(([id, label]) => (
							<button
								type="button"
								className="quiet"
								key={id}
								aria-current={section === id ? "page" : undefined}
								onClick={() => select(id)}
							>
								{label}
							</button>
						))}
					</nav>
				)}
				<section className="command-sidebar-scroll" key={section} aria-label={`${title} items`}>
					{section === "fixes" && fixes ? (
						<PRFixList
							controller={fixes}
							selectedId={selectedId ?? undefined}
							onSelect={(id) => select("fixes", id)}
						/>
					) : section === "slack" && slack ? (
						<SlackConversationList
							controller={slack}
							selectedId={selectedId ?? undefined}
							onSelect={(id) => select("slack", id)}
						/>
					) : section === "day" && day ? (
						<DayQueue
							controller={day}
							selectedId={selectedId ?? undefined}
							onOpenItem={(id) => select("day", id)}
						/>
					) : !snapshot ? (
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
									<div className="command-group-title">Recent canvases</div>
									{recentCanvases.map((item) => (
										<button
											type="button"
											className="command-item quiet"
											key={item.id}
											onClick={() => command({ kind: "focus-canvas", id: item.id })}
										>
											<span className="command-item-title">{item.title}</span>
											<span className="command-item-meta">
												{item.kind === "flow"
													? "Source flow"
													: item.kind === "visual"
														? "Visual draft"
														: item.kind === "source"
															? "Source"
															: "Document"}
											</span>
										</button>
									))}
									{!recentCanvases.length && (
										<p className="hub-sidebar-empty">
											Choose a section to browse your work. Your saved canvases will appear here.
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
															aria-busy={
																workspaceState.loadingReview?.prId === item.pr.id || undefined
															}
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
													{job.headSha ? ` · ${job.headSha.slice(0, 7)}` : ""}
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

function SlackRailButton({
	controller,
	selected,
	onBrowse,
}: { controller: SlackBrowseController; selected: boolean; onBrowse(): void }) {
	const { conversations, listLoaded, listHasMore } = useStore(controller.store);
	const count = listLoaded ? conversations.length : undefined;
	const label = `Slack${count === undefined ? "" : ` (${count}${listHasMore ? "+" : ""})`}`;
	return (
		<button
			type="button"
			className="quiet"
			title={label}
			aria-label={label}
			aria-current={selected ? "page" : undefined}
			onClick={onBrowse}
		>
			<HubIcon name="slack" />
			<span className="command-rail-label">Slack</span>
			{count !== undefined && count > 0 && (
				<span className="command-rail-count" aria-hidden="true">
					{count}
					{listHasMore ? "+" : ""}
				</span>
			)}
		</button>
	);
}

function DayRailButton({
	day,
	selected,
	onBrowse,
}: { day: DayController; selected: boolean; onBrowse(): void }) {
	const snapshot = useStore(day.store).snapshot;
	const count = snapshot?.items.filter(
		(item) => !["closed", "cancelled"].includes(item.phase)
	).length;
	const label = `My day${count === undefined ? "" : ` (${count})`}`;
	return (
		<button
			type="button"
			className="quiet"
			title={label}
			aria-label={label}
			aria-current={selected ? "page" : undefined}
			onClick={onBrowse}
		>
			<HubIcon name="day" />
			<span className="command-rail-label">My day</span>
			{count !== undefined && count > 0 && (
				<span className="command-rail-count" aria-hidden="true">
					{count}
				</span>
			)}
		</button>
	);
}
