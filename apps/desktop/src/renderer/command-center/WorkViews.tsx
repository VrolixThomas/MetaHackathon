import { useEffect, useState } from "react";
import type { z } from "zod";
import { useStore } from "zustand";
import type {
	CodeLocation,
	HubOperation,
	LinearTicket,
	PinnedSource,
	WorkJob,
	WorkReviewSchema,
	WorkspaceCommand,
} from "../../shared/contracts";
import { SyntaxText } from "../prepared/ReviewWorkspace";
import { patchLines, sourceLines } from "../prepared/diff";
import { type HighlightedSource, highlightSource } from "../prepared/highlighting";
import { MarkdownContent } from "../workspace/MarkdownContent";
import { SourceBlock } from "./SourceCanvas";
import type { HubController } from "./controller";
import { jobOutcomeLabel, jobReference, jobTitle, priorityLabel, stateLabel } from "./model";

type WorkReview = z.infer<typeof WorkReviewSchema>;
type Command = (input: WorkspaceCommand) => void;

export function TicketView({
	hub,
	id,
	sequence,
	command,
}: { hub: HubController; id: string; sequence: number; command: Command }) {
	const { snapshot, busy } = useStore(hub.store);
	const [ticket, setTicket] = useState<LinearTicket | null>(null);
	const [error, setError] = useState("");
	const [repositoryId, setRepositoryId] = useState("");
	const [brief, setBrief] = useState("");
	// biome-ignore lint/correctness/useExhaustiveDependencies: A newer hub sequence invalidates saved detail and log data.
	useEffect(() => {
		let current = true;
		setError("");
		void hub
			.ticket(id)
			.then((value) => {
				if (current) setTicket(value);
			})
			.catch(() => {
				if (current) setError("This ticket is unavailable. Refresh to try again.");
			});
		return () => {
			current = false;
		};
	}, [hub, id, sequence]);
	if (ticket?.id !== id)
		return (
			<p className={error ? "hub-error" : "hub-muted"} aria-live="polite">
				{error || "Loading ticket…"}
			</p>
		);
	const existing = snapshot?.jobs.filter((job) => job.ticket?.id === ticket.id) ?? [];
	const repository = snapshot?.repositories.find((repo) => repo.id === repositoryId);
	return (
		<article className="hub-detail">
			<div className="hub-detail-meta">
				<span>{ticket.identifier}</span>
				<span>{ticket.state.name}</span>
				<span>{priorityLabel(ticket.priority)}</span>
				<span>
					{ticket.teamName}
					{ticket.projectName ? ` / ${ticket.projectName}` : ""}
				</span>
			</div>
			<h1>{ticket.title}</h1>
			<p className="hub-muted">Assigned to {ticket.assigneeName}</p>
			<div className="hub-actions">
				<button
					type="button"
					className="quiet"
					onClick={() => command({ kind: "open-browser", url: ticket.url })}
				>
					Open in Linear ↗
				</button>
			</div>
			<div className="canvas-markdown hub-ticket-description">
				{ticket.description ? (
					<MarkdownContent
						markdown={ticket.description}
						onOpenUrl={(url) => command({ kind: "open-browser", url })}
					/>
				) : (
					<p className="hub-muted">This ticket has no description.</p>
				)}
			</div>
			{error && (
				<p role="alert" className="hub-error">
					{error}
				</p>
			)}
			{existing.length > 0 && (
				<section className="hub-existing-jobs">
					<h2>Saved work</h2>
					{existing.map((job) => (
						<button
							type="button"
							key={job.id}
							className="hub-list-row quiet"
							onClick={() =>
								command({ kind: "open-center", section: "activity", selectedId: job.id })
							}
						>
							<span>{job.branch}</span>
							<span className={`hub-status status-${job.state}`}>{stateLabel(job.state)}</span>
						</button>
					))}
				</section>
			)}
			<form
				className="hub-form hub-start-work"
				onSubmit={(event) => {
					event.preventDefault();
					if (!repository || !brief.trim()) return;
					void hub
						.operate({
							kind: "start-work",
							ticketId: ticket.id,
							repositoryId: repository.id,
							brief: brief.trim(),
						})
						.then((result) => {
							if (result?.jobId)
								command({ kind: "open-center", section: "activity", selectedId: result.jobId });
						});
				}}
			>
				<h2>Start a coding worker</h2>
				<p className="hub-muted">
					Choose the checkout and clarify the outcome. The app saves the job so you can pause and
					return to it.
				</p>
				<label>
					Repository
					<select
						required
						value={repositoryId}
						onChange={(event) => setRepositoryId(event.currentTarget.value)}
					>
						<option value="">Select the repository for this ticket…</option>
						{snapshot?.repositories.map((repo) => (
							<option key={repo.id} value={repo.id}>
								{repo.repository}
								{repo.localPath ? "" : " · no local checkout"}
							</option>
						))}
					</select>
				</label>
				{repository && (
					<p className="hub-muted">
						{repository.localPath ??
							"Add a local checkout in Home → Connections before starting local work."}
					</p>
				)}
				<label>
					Clarified brief
					<textarea
						required
						rows={5}
						maxLength={20000}
						value={brief}
						onChange={(event) => setBrief(event.currentTarget.value)}
						placeholder="Describe the change, acceptance criteria, constraints, and checks the worker should run."
					/>
				</label>
				{snapshot && !(snapshot.connections.coding ?? snapshot.connections.model) && (
					<p className="hub-muted">Connect your coding provider in Settings to run a worker.</p>
				)}
				<button
					type="submit"
					disabled={
						busy ||
						!repository?.localPath ||
						!brief.trim() ||
						!(snapshot?.connections.coding ?? snapshot?.connections.model)
					}
				>
					{busy ? "Starting…" : "Start work"}
				</button>
			</form>
		</article>
	);
}

export function WorkDiff({
	review,
	command,
	selectedPath,
	onSelectFile,
	view: controlledView,
	onViewChange,
	labels = { base: "Base", head: "Head" },
	navigation = false,
	showLineCounts = false,
	fileSidebar = false,
}: {
	review: WorkReview;
	command: Command;
	selectedPath?: string;
	onSelectFile?(path: string): void;
	view?: "diff" | "base" | "head";
	onViewChange?(view: "diff" | "base" | "head"): void;
	labels?: { base: string; head: string };
	navigation?: boolean;
	showLineCounts?: boolean;
	fileSidebar?: boolean;
}) {
	const [selected, setSelected] = useState("");
	const [localView, setView] = useState<"diff" | "base" | "head">("diff");
	const view = controlledView ?? localView;
	const file =
		review.files.find((item) => item.path === (selectedPath ?? selected)) ?? review.files[0];
	const selectFile = (path: string) => (onSelectFile ? onSelectFile(path) : setSelected(path));
	const [syntax, setSyntax] = useState<{
		file: typeof file;
		base: HighlightedSource;
		head: HighlightedSource;
	} | null>(null);
	useEffect(() => {
		let current = true;
		if (file)
			void Promise.all([highlightSource(file.base), highlightSource(file.head)]).then(
				([base, head]) => {
					if (current) setSyntax({ file, base, head });
				}
			);
		return () => {
			current = false;
		};
	}, [file]);
	if (!file) return <p className="hub-muted">This job has no changed files to inspect.</p>;
	const open = (location: CodeLocation) => command({ kind: "open-source", location });
	const source = view === "diff" ? null : file[view];
	const pinned: PinnedSource | null =
		source?.status === "available" && source.content !== null
			? {
					location: {
						repository: review.job.repository,
						revision: view === "base" ? "base" : "head",
						commitSha: source.commitSha,
						path: source.path,
						startLine: 1,
						endLine: Math.max(1, sourceLines(source.content).length),
					},
					text: source.content,
					language: null,
					truncated: false,
				}
			: null;
	let patchOffset = 0;
	return (
		<section
			className={`hub-work-review ${fileSidebar ? "job-review-grid" : ""}`}
			aria-label="Local work review"
		>
			{fileSidebar && (
				<aside className="job-change-sidebar" aria-label="Implementation changes">
					<div className="job-change-heading">
						<strong>Branch changes</strong>
						<span>{review.files.length} files</span>
					</div>
					<div className="job-change-totals">
						<span className="job-added">
							+
							{review.files.reduce(
								(sum, f) =>
									sum +
									(f.patch === null
										? 0
										: patchLines(f.patch).filter((l) => l.kind === "add").length),
								0
							)}
						</span>
						<span className="job-removed">
							−
							{review.files.reduce(
								(sum, f) =>
									sum +
									(f.patch === null
										? 0
										: patchLines(f.patch).filter((l) => l.kind === "remove").length),
								0
							)}
						</span>
					</div>
					<nav aria-label="Changed files">
						{review.files.map((entry) => (
							<button
								type="button"
								key={entry.path}
								className="job-file-row quiet"
								aria-current={file.path === entry.path ? "true" : undefined}
								onClick={() => selectFile(entry.path)}
								title={entry.path}
							>
								<span className={`job-file-status status-${entry.status}`}>
									{entry.status === "added"
										? "A"
										: entry.status === "removed"
											? "D"
											: entry.status === "renamed"
												? "R"
												: "M"}
								</span>
								<span className="job-file-path">{entry.path}</span>
								{entry.patch !== null && (
									<small>
										<span className="job-added">
											+{patchLines(entry.patch).filter((l) => l.kind === "add").length}
										</span>{" "}
										<span className="job-removed">
											−{patchLines(entry.patch).filter((l) => l.kind === "remove").length}
										</span>
									</small>
								)}
							</button>
						))}
					</nav>
					<div className="job-commit">
						<span className="eyebrow">Implementation revision</span>
						<code title={review.job.headSha ?? undefined}>{review.job.headSha?.slice(0, 10)}</code>
						<span>{review.job.branch}</span>
						<time dateTime={review.job.updatedAt}>
							{new Date(review.job.updatedAt).toLocaleString()}
						</time>
						<small>Compared with {review.job.baseSha?.slice(0, 10)}</small>
					</div>
				</aside>
			)}
			<div className="job-diff-pane">
				{fileSidebar && (
					<header className="job-diff-heading">
						<strong>{file.path}</strong>
						<span>{file.status}</span>
					</header>
				)}
				<div className="hub-actions">
					{!fileSidebar && (
						<label className="hub-file-select">
							Changed file
							<select value={file.path} onChange={(event) => selectFile(event.currentTarget.value)}>
								{review.files.map((entry) => (
									<option value={entry.path} key={entry.path}>
										{entry.path} · {entry.status}
										{showLineCounts && entry.patch !== null
											? ` · +${patchLines(entry.patch).filter((line) => line.kind === "add").length} −${patchLines(entry.patch).filter((line) => line.kind === "remove").length}`
											: ""}
									</option>
								))}
							</select>
						</label>
					)}
					<div className="hub-view-controls">
						{(["diff", "base", "head"] as const).map((mode) => (
							<button
								type="button"
								key={mode}
								className="quiet"
								aria-pressed={view === mode}
								onClick={() => (onViewChange ? onViewChange(mode) : setView(mode))}
							>
								{mode === "diff" ? "Diff" : labels[mode]}
							</button>
						))}
					</div>
					{navigation && (
						<div className="hub-actions" aria-label="Changed file navigation">
							<button
								type="button"
								className="quiet"
								disabled={review.files.indexOf(file) <= 0}
								onClick={() => {
									const previous = review.files[review.files.indexOf(file) - 1];
									if (previous) selectFile(previous.path);
								}}
							>
								Previous file
							</button>
							<span>
								File {review.files.indexOf(file) + 1} of {review.files.length}
							</span>
							<button
								type="button"
								className="quiet"
								disabled={review.files.indexOf(file) >= review.files.length - 1}
								onClick={() => {
									const next = review.files[review.files.indexOf(file) + 1];
									if (next) selectFile(next.path);
								}}
							>
								Next file
							</button>
						</div>
					)}
				</div>
				<div className="hub-revision-pair">
					<span title={file.base.commitSha}>
						{labels.base} {file.base.commitSha.slice(0, 10)}
					</span>
					<span title={file.head.commitSha}>
						{labels.head} {file.head.commitSha.slice(0, 10)}
					</span>
				</div>
				{view !== "diff" ? (
					pinned ? (
						<SourceBlock source={pinned} onReference={open} />
					) : (
						<p className="hub-muted">Source {source?.status ?? "unavailable"} at this revision.</p>
					)
				) : file.patch !== null ? (
					<pre className="hub-work-diff" aria-label={`Diff: ${file.path}`}>
						<code>
							{patchLines(file.patch).map((line) => {
								const offset = patchOffset;
								patchOffset += line.text.length + 1;
								const side = line.kind === "remove" ? "base" : "head";
								const number = line[side];
								const tokens =
									syntax?.file === file && number !== undefined
										? syntax[side].lines[number - 1]
										: undefined;
								return (
									<span className={`hub-diff-row diff-${line.kind}`} key={offset}>
										<button
											type="button"
											className="hub-line-number"
											disabled={number === undefined}
											aria-label={
												number === undefined
													? "Diff metadata"
													: `Open ${side} ${file.path} line ${number}`
											}
											onClick={() => {
												if (number !== undefined)
													open({
														repository: review.job.repository,
														path: file[side].path,
														commitSha: file[side].commitSha,
														revision: side,
														startLine: number,
														endLine: number,
													});
											}}
										>
											{line.base ?? ""}
										</button>
										<span className="hub-line-number" aria-hidden="true">
											{line.head ?? ""}
										</span>
										<span className="hub-diff-sign" aria-hidden="true">
											{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
										</span>
										<span>
											<SyntaxText text={line.text} tokens={tokens} />
											{"\n"}
										</span>
									</span>
								);
							})}
						</code>
					</pre>
				) : (
					<p className="hub-muted">
						No text diff is available. Select Base or Head to inspect available pinned source.
					</p>
				)}
			</div>
		</section>
	);
}

function JobLog({ hub, id, sequence }: { hub: HubController; id: string; sequence: number }) {
	const [log, setLog] = useState<{
		jobId: string;
		cursor: number;
		lines: string[];
		truncated: boolean;
	} | null>(null);
	const [error, setError] = useState("");
	const [page, setPage] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: A newer hub sequence invalidates saved detail and log data.
	useEffect(() => {
		let current = true;
		setError("");
		void hub
			.jobLog(id, page)
			.then((result) => {
				if (current) setLog(result);
			})
			.catch(() => {
				if (current) setError("Worker log is unavailable.");
			});
		return () => {
			current = false;
		};
	}, [hub, id, sequence, page]);
	return (
		<details className="hub-log">
			<summary>Worker activity log</summary>
			{error && <p className="hub-error">{error}</p>}
			{log?.jobId === id ? (
				<>
					<pre>{log.lines.length ? log.lines.join("\n") : "No log output at this cursor."}</pre>
					<div className="hub-actions">
						<button
							type="button"
							className="quiet"
							disabled={page === 0}
							onClick={() => setPage(0)}
						>
							From start
						</button>
						<button
							type="button"
							className="quiet"
							disabled={!log.truncated || log.cursor <= page}
							onClick={() => setPage(log.cursor)}
						>
							Next log page
						</button>
					</div>
				</>
			) : (
				<p aria-live="polite">Loading log…</p>
			)}
		</details>
	);
}

/** Approval is bound to the actual loaded local review and current pinned revisions. */
export function loadedReviewMatchesJob(job: WorkJob, review: WorkReview | null): boolean {
	return (
		!!review &&
		!!job.baseSha &&
		!!job.headSha &&
		review.job.id === job.id &&
		review.job.repository === job.repository &&
		review.job.baseSha === job.baseSha &&
		review.job.headSha === job.headSha
	);
}

export function WorkAcceptance({
	job,
	review,
	busy,
	operate,
}: {
	job: WorkJob;
	review: WorkReview | null;
	busy: boolean;
	operate(input: HubOperation): ReturnType<HubController["operate"]>;
}) {
	const [instruction, setInstruction] = useState("");
	const reviewed = loadedReviewMatchesJob(job, review);
	return (
		<section aria-label="Work review actions">
			{job.reviewedAt && (
				<p className="hub-muted">
					Accepted ·{" "}
					<time dateTime={job.reviewedAt}>{new Date(job.reviewedAt).toLocaleString()}</time>
				</p>
			)}
			{job.feedbackAppliedAt && (
				<p className="hub-muted">
					Applied ·{" "}
					<time dateTime={job.feedbackAppliedAt}>
						{new Date(job.feedbackAppliedAt).toLocaleString()}
					</time>
				</p>
			)}
			{job.publishedHeadSha && (
				<p className="hub-muted">
					Published head: <code>{job.publishedHeadSha}</code>
				</p>
			)}
			{job.state === "ready" && !job.reviewedAt && (
				<>
					<div className="hub-actions">
						<button
							type="button"
							disabled={busy || !reviewed}
							onClick={() => {
								if (!busy && reviewed && job.headSha)
									void operate({
										kind: "approve-work",
										jobId: job.id,
										headSha: job.headSha,
										confirmed: true,
									});
							}}
						>
							{job.ticket ? "Accept work and complete ticket" : "Accept work"}
						</button>
					</div>
					{!reviewed && (
						<p className="hub-muted">Load the current local diff before accepting this work.</p>
					)}
					<form
						className="hub-form"
						onSubmit={(event) => {
							event.preventDefault();
							const requested = instruction.trim();
							if (requested && !busy)
								void operate({ kind: "revise-work", jobId: job.id, instruction: requested }).then(
									(result) => {
										if (result) setInstruction("");
									}
								);
						}}
					>
						<label>
							Requested changes
							<textarea
								rows={3}
								required
								maxLength={10000}
								value={instruction}
								onChange={(event) => setInstruction(event.currentTarget.value)}
							/>
						</label>
						<p className="hub-muted">
							The worker will revise this saved job in its current checkout.
						</p>
						<button type="submit" disabled={busy || !instruction.trim()}>
							Request changes
						</button>
					</form>
				</>
			)}
			{!!job.revisions?.length && (
				<details className="hub-disclosure">
					<summary>Requested revisions</summary>
					{job.revisions.map((revision) => (
						<div key={`${revision.createdAt}:${revision.instruction}`}>
							<time dateTime={revision.createdAt}>
								{new Date(revision.createdAt).toLocaleString()}
							</time>
							<p className="hub-preserve">{revision.instruction}</p>
						</div>
					))}
				</details>
			)}
		</section>
	);
}

export function JobView({
	hub,
	id,
	sequence,
	command,
}: { hub: HubController; id: string; sequence: number; command: Command }) {
	const { busy } = useStore(hub.store);
	const [job, setJob] = useState<WorkJob | null>(null);
	const [error, setError] = useState("");
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [review, setReview] = useState<WorkReview | null>(null);
	const [reviewBusy, setReviewBusy] = useState(false);
	const [reviewError, setReviewError] = useState("");
	const [reviewReload, setReviewReload] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Reload only for immutable source identity changes or explicit retry, not every hub poll.
	useEffect(() => {
		let current = true;
		setReview(null);
		setReviewError("");
		if (!job || job.id !== id || !job.baseSha || !job.headSha) {
			setReviewBusy(false);
			return;
		}
		const expected = job;
		setReviewBusy(true);
		void hub
			.reviewWork(id)
			.then((result) => {
				if (current && loadedReviewMatchesJob(expected, result)) setReview(result);
				else if (current)
					setReviewError("The implementation changed. Reload to inspect its current revision.");
			})
			.catch(() => {
				if (current)
					setReviewError(
						"This saved checkout could not be verified. Reload the changes or select another run; acceptance stays disabled until its diff is available."
					);
			})
			.finally(() => {
				if (current) setReviewBusy(false);
			});
		return () => {
			current = false;
		};
	}, [hub, id, job?.id, job?.baseSha, job?.headSha, job?.repository, reviewReload]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: A newer hub sequence invalidates saved detail and log data.
	useEffect(() => {
		let current = true;
		setError("");
		void hub
			.job(id)
			.then((value) => {
				if (current) setJob(value);
			})
			.catch(() => {
				if (current) setError("This saved job is unavailable. Refresh to try again.");
			});
		return () => {
			current = false;
		};
	}, [hub, id, sequence]);
	if (job?.id !== id)
		return (
			<p className={error ? "hub-error" : "hub-muted"} aria-live="polite">
				{error || "Loading saved job…"}
			</p>
		);
	const active = ["queued", "running", "validating", "needs-input"].includes(job.state);
	const resumable = ["paused", "failed"].includes(job.state);
	return (
		<article
			className="hub-detail job-detail"
			data-job-id={job.id}
			data-job-head={job.headSha ?? "pending"}
			data-job-repository={job.repository}
		>
			<div className="hub-detail-meta">
				<span>{jobReference(job)}</span>
				<span>{job.repository}</span>
				<span className={`hub-status status-${job.state}`}>{jobOutcomeLabel(job)}</span>
			</div>
			<h1>{jobTitle(job)}</h1>
			<p className="hub-muted hub-branch">{job.branch}</p>
			{error && (
				<p className="hub-error" role="alert">
					{error}
				</p>
			)}
			{job.error && (
				<p className="hub-error" role="alert">
					{job.error}
				</p>
			)}
			<div className="hub-actions">
				{active && (
					<button
						type="button"
						disabled={busy}
						onClick={() => void hub.operate({ kind: "pause-work", jobId: id })}
					>
						Pause work
					</button>
				)}
				{job.state === "ready" && !job.pullRequest && job.changedFiles.length > 0 && (
					<button
						type="button"
						disabled={busy}
						onClick={() => void hub.operate({ kind: "publish-work", jobId: id })}
					>
						Publish draft PR
					</button>
				)}
				{resumable && (
					<button
						type="button"
						disabled={busy}
						onClick={() => void hub.operate({ kind: "resume-work", jobId: id })}
					>
						Resume work
					</button>
				)}
				{(active || job.state === "paused") && (
					<button
						type="button"
						className="quiet"
						disabled={busy}
						onClick={() => void hub.operate({ kind: "cancel-work", jobId: id })}
					>
						Cancel job
					</button>
				)}
				{job.pullRequest && (
					<button
						type="button"
						onClick={() => {
							if (job.pullRequest) command({ kind: "show-review", prId: job.pullRequest.id });
						}}
					>
						Open PR #{job.pullRequest.number}
					</button>
				)}
			</div>
			<section>
				<div className="hub-section-heading">
					<h2>
						Implementation <span className="hub-count">{job.changedFiles.length}</span>
					</h2>
					<button
						type="button"
						className="quiet"
						disabled={reviewBusy || !job.baseSha || !job.headSha}
						onClick={() => setReviewReload((value) => value + 1)}
					>
						{reviewBusy ? "Loading diff…" : "Reload changes"}
					</button>
				</div>
				{reviewError && (
					<p className="hub-error" role="alert">
						{reviewError}
					</p>
				)}
				{review && loadedReviewMatchesJob(job, review) ? (
					<WorkDiff
						key={`${review.job.id}:${review.job.headSha}`}
						review={review}
						command={command}
						fileSidebar
						navigation
						showLineCounts
						labels={{ base: "Before", head: "After" }}
					/>
				) : job.changedFiles.length ? (
					<ul className="hub-changed-files">
						{job.changedFiles.map((path) => (
							<li key={path}>{path}</li>
						))}
					</ul>
				) : (
					<p className="hub-muted">No changed files recorded yet.</p>
				)}
			</section>
			{job.summary && (
				<details className="canvas-markdown hub-job-summary hub-disclosure">
					<summary>What the agent changed</summary>
					<MarkdownContent
						markdown={job.summary}
						onOpenUrl={(url) => command({ kind: "open-browser", url })}
					/>
				</details>
			)}
			{job.decisions
				.filter((decision) => decision.answer === null)
				.map((decision) => (
					<form
						className="hub-decision"
						key={decision.id}
						onSubmit={(event) => {
							event.preventDefault();
							const answer = answers[decision.id]?.trim();
							if (answer)
								void hub.operate({
									kind: "answer-decision",
									jobId: id,
									decisionId: decision.id,
									answer,
								});
						}}
					>
						<span className="eyebrow">Decision needed</span>
						<h2>{decision.question}</h2>
						<p>{decision.reason}</p>
						<label>
							Your answer
							<textarea
								rows={3}
								required
								maxLength={10000}
								value={answers[decision.id] ?? ""}
								onChange={(event) => {
									const value = event.currentTarget.value;
									setAnswers((previous) => ({
										...previous,
										[decision.id]: value,
									}));
								}}
							/>
						</label>
						<button type="submit" disabled={busy || !answers[decision.id]?.trim()}>
							Send decision
						</button>
					</form>
				))}
			{job.decisions.some((decision) => decision.answer !== null) && (
				<details className="hub-disclosure">
					<summary>Answered decisions</summary>
					{job.decisions
						.filter((decision) => decision.answer !== null)
						.map((decision) => (
							<div key={decision.id}>
								<strong>{decision.question}</strong>
								<p>{decision.answer}</p>
							</div>
						))}
				</details>
			)}
			<details className="hub-disclosure">
				<summary>Original brief and checkout</summary>
				<p className="hub-preserve">{job.brief}</p>
				<p className="hub-muted">{job.worktreePath ?? "Checkout not created yet"}</p>
				<p className="hub-muted">
					Base: {job.baseSha ?? "Not pinned yet"}
					<br />
					Head: {job.headSha ?? "Not pinned yet"}
				</p>
			</details>
			<section className="hub-checks">
				<h2>Checks and outcome</h2>
				{job.checks.length ? (
					job.checks.map((check) => (
						<div key={check.id} className="hub-check">
							<span
								className={`hub-status ${check.exitCode === 0 ? "status-ready" : "status-failed"}`}
							>
								Exit {check.exitCode}
							</span>
							<code>{[check.command, ...check.args].join(" ")}</code>
							<small title={check.commitSha}>
								{check.commitSha.slice(0, 10)} · {new Date(check.finishedAt).toLocaleString()}
							</small>
						</div>
					))
				) : (
					<p className="hub-muted">No executed checks recorded.</p>
				)}
			</section>
			<WorkAcceptance
				key={`${job.id}:${job.headSha}`}
				job={job}
				review={review}
				busy={busy || reviewBusy}
				operate={hub.operate}
			/>
			<JobLog hub={hub} id={id} sequence={sequence} />
		</article>
	);
}
