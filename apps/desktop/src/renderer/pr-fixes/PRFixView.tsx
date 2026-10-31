import { useEffect, useState } from "react";
import { useStore } from "zustand";
import {
	type PRFixDetail,
	type PullRequestFeedback,
	type WorkspaceCommand,
	encodePRFixViewTarget,
} from "../../shared/contracts";
import { WorkDiff } from "../command-center/WorkViews";
import type { PRFixController } from "./controller";
import { diffLineCounts, fixPhaseLabel, hasCandidateSource, loadedReviewMatchesFix } from "./model";

type Command = (input: WorkspaceCommand) => void;
export function PRFixList({
	controller,
	selectedId,
	onSelect,
}: {
	controller: PRFixController;
	selectedId?: string;
	onSelect(target: string): void;
}) {
	const state = useStore(controller.store);
	return (
		<div className="pr-fix-list">
			<div className="command-group-title">
				<span>Suggested fixes</span>
				<span>{state.listLoaded ? state.items.length : "…"}</span>
			</div>
			{state.error && (
				<p className="hub-error" role="alert">
					{state.error}
				</p>
			)}
			{!state.listLoaded && (
				<p className="hub-sidebar-empty">
					{state.listLoading ? "Loading suggested fixes…" : "Suggested fixes have not been loaded."}
				</p>
			)}
			{state.listLoaded && !state.items.length && (
				<p className="hub-sidebar-empty">
					Prepare a suggested fix from an original PR feedback item. Candidates stay local.
				</p>
			)}
			{state.items.map((fix) => (
				<button
					type="button"
					className="command-item quiet"
					key={fix.id}
					aria-current={
						selectedId === encodePRFixViewTarget({ id: fix.id, path: null }) ||
						(state.detail?.fix.id === fix.id && selectedId === state.loadedTarget)
							? "true"
							: undefined
					}
					onClick={() => onSelect(encodePRFixViewTarget({ id: fix.id, path: null }))}
				>
					<span className="command-item-title">{fix.pr.title}</span>
					<span className="command-item-meta">
						{fix.pr.repository} #{fix.pr.number} · {fixPhaseLabel(fix)}
					</span>
					<span className="command-item-meta">
						{fix.changedFiles.length} changed file{fix.changedFiles.length === 1 ? "" : "s"} ·{" "}
						{fix.feedback.author}
					</span>
				</button>
			))}
			<button
				type="button"
				className="quiet"
				disabled={state.listLoading}
				onClick={() => void controller.poll()}
			>
				Refresh fixes
			</button>
		</div>
	);
}

/** Never routes through the ordinary hub feedback worker, which can apply changes. */
export async function prepareSuggestedFix(
	controller: PRFixController,
	feedback: PullRequestFeedback,
	command: Command
) {
	if (!feedback.body.trim()) return;
	const result = await controller.start({ prId: feedback.prId, feedbackId: feedback.id });
	if (result)
		command({
			kind: "open-center",
			section: "fixes",
			selectedId: encodePRFixViewTarget({ id: result.id, path: null }),
		});
}
export function PrepareSuggestedFixButton({
	controller,
	feedback,
	command,
}: {
	controller: PRFixController;
	feedback: PullRequestFeedback;
	command: Command;
}) {
	const { busy } = useStore(controller.store);
	if (!feedback.body.trim()) return null;
	return (
		<button
			type="button"
			disabled={busy}
			onClick={() => void prepareSuggestedFix(controller, feedback, command)}
		>
			Prepare suggested fix
		</button>
	);
}

export function PRFixReview({
	detail,
	controller,
	selectedPath,
	onNavigate,
	command,
}: {
	detail: PRFixDetail;
	controller: PRFixController;
	selectedPath: string | null;
	onNavigate(target: string): void;
	command: Command;
}) {
	const { fix, review } = detail;
	const receiptMarker = "\n\nRecorded worker receipts:";
	const receiptAt = fix.summary.indexOf(receiptMarker);
	const explanation = receiptAt < 0 ? fix.summary : fix.summary.slice(0, receiptAt);
	const workerNotes = receiptAt < 0 ? null : fix.summary.slice(receiptAt + 2);
	const state = useStore(controller.store);
	const [view, setView] = useState<"diff" | "base" | "head">("diff");
	const matching = loadedReviewMatchesFix(detail);
	const selected = review?.files.find((file) => file.path === selectedPath);
	const shown = matching && hasCandidateSource(selected, view);
	const current =
		state.detail === detail &&
		state.loadedTarget === state.target &&
		!state.detailLoading &&
		!state.detailError;
	const canReview = current && shown && fix.phase === "ready" && !fix.reviewedAt && !state.busy;
	return (
		<article
			className="hub-detail pr-fix-review"
			data-pr-fix-id={shown && current ? fix.id : undefined}
			data-pr-fix-status-id={!shown && current ? fix.id : undefined}
			data-pr-fix-head={fix.headSha ?? "pending"}
			data-pr-fix-base={fix.baseSha}
			data-pr-fix-path={current ? (selected?.path ?? "") : undefined}
		>
			<div className="hub-detail-meta">
				<span>
					{fix.pr.repository} #{fix.pr.number}
				</span>
				<span className="hub-status">{fixPhaseLabel(fix)}</span>
				<span className="hub-muted">
					{fix.checks.length === 0
						? "Checks not run"
						: fix.checks.every((check) => check.exitCode === 0 && check.commitSha === fix.headSha)
							? `${fix.checks.length} check${fix.checks.length === 1 ? "" : "s"} passed`
							: "Check results need attention"}
				</span>
			</div>
			<h1>Suggested fix · {fix.pr.title}</h1>
			<p className="hub-muted">Local candidate · not published</p>
			<details className="pr-fix-revisions">
				<summary>Revisions</summary>
				<p className="pr-fix-pin">
					Original PR head <code>{fix.pr.headSha}</code>
					<br />
					Candidate head <code>{fix.headSha ?? "Not created yet"}</code>
				</p>
				<p>Reviewing it records no author approval.</p>
			</details>
			<section aria-label="Original feedback" className="pr-fix-feedback">
				<h2>Original feedback</h2>
				<p>
					<strong>{fix.feedback.author}</strong> ·{" "}
					<time dateTime={fix.feedback.updatedAt}>
						{new Date(fix.feedback.updatedAt).toLocaleString()}
					</time>
				</p>
				{fix.feedback.path && (
					<p>
						{fix.feedback.path}
						{fix.feedback.line
							? `:${fix.feedback.startLine ?? fix.feedback.line}–${fix.feedback.line}`
							: ""}
					</p>
				)}
				{fix.feedback.commitSha && (
					<details className="pr-fix-revisions">
						<summary>Feedback revision</summary>
						<p className="pr-fix-pin">
							Feedback source commit <code>{fix.feedback.commitSha}</code>
						</p>
					</details>
				)}
				<pre className="pr-fix-original">{fix.feedback.body}</pre>
				<button
					type="button"
					className="quiet"
					onClick={() => command({ kind: "open-browser", url: fix.feedback.url })}
				>
					View original thread ↗
				</button>
			</section>
			<section aria-label="Agent summary">
				<h2>Agent summary</h2>
				<p className="hub-preserve">{explanation || "No agent summary has been recorded yet."}</p>
				{workerNotes && (
					<details className="pr-fix-revisions">
						<summary>Worker notes</summary>
						<p className="hub-preserve">{workerNotes}</p>
					</details>
				)}
			</section>
			{fix.phase === "needs-input" && (
				<section className="hub-decision">
					<h2>Needs your input</h2>
					<p className="hub-preserve">
						{fix.question || "The worker stopped because it needs more context."}
					</p>
					<p className="hub-muted">Preparation is paused. No fix has been applied.</p>
				</section>
			)}
			{fix.phase === "interrupted" && (
				<p className="hub-error" role="alert">
					Preparation was interrupted. This saved candidate has not been automatically restarted.
				</p>
			)}
			{fix.phase === "failed" && (
				<p className="hub-error" role="alert">
					Fix preparation failed. Inspect the recorded outcome and checks.
				</p>
			)}
			{fix.error && (
				<p className="hub-error hub-preserve" role="alert">
					{fix.error}
				</p>
			)}
			<section aria-label="Candidate changes">
				<h2>Changed files · {fix.changedFiles.length}</h2>
				{review && matching ? (
					<>
						<ul className="pr-fix-files">
							{review.files.map((file) => {
								const counts = diffLineCounts(file);
								return (
									<li key={file.path}>
										<button
											type="button"
											className="quiet"
											aria-current={file.path === selectedPath ? "true" : undefined}
											onClick={() =>
												onNavigate(encodePRFixViewTarget({ id: fix.id, path: file.path }))
											}
										>
											{file.path}{" "}
											<span>
												{counts ? `+${counts.added} −${counts.removed}` : "Diff unavailable"}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
						{review.files.length ? (
							<WorkDiff
								review={review}
								command={command}
								selectedPath={selectedPath ?? undefined}
								onSelectFile={(path) => onNavigate(encodePRFixViewTarget({ id: fix.id, path }))}
								view={view}
								onViewChange={setView}
								labels={{ base: "Before", head: "Proposed after" }}
								navigation
								showLineCounts
							/>
						) : (
							<p className="hub-muted">
								No changed files were produced. There is no candidate diff to review.
							</p>
						)}
					</>
				) : (
					<>
						<ul className="hub-changed-files">
							{fix.changedFiles.map((path) => (
								<li key={path}>{path}</li>
							))}
						</ul>
						<p className="hub-muted">
							{fix.headSha
								? "The candidate's exact diff is unavailable. Refresh to retry."
								: "The worker has not produced a candidate commit yet."}
						</p>
					</>
				)}
			</section>
			<section className="hub-checks" aria-label="Actual checks">
				<h2>Actual checks</h2>
				{fix.checks.length ? (
					fix.checks.map((check) => (
						<div key={check.id} className="hub-check pr-fix-check">
							<span
								className={
									check.exitCode === 0 ? "hub-status status-ready" : "hub-status status-failed"
								}
							>
								Exit {check.exitCode}
							</span>
							<code>{[check.command, ...check.args].join(" ")}</code>
							<small className="pr-fix-pin">
								Commit <code>{check.commitSha}</code>
							</small>
							<small>
								<time dateTime={check.startedAt}>{check.startedAt}</time> →{" "}
								<time dateTime={check.finishedAt}>{check.finishedAt}</time>
							</small>
							{check.commitSha !== fix.headSha && (
								<p className="hub-muted">
									This check ran on a different commit from the proposed candidate.
								</p>
							)}
						</div>
					))
				) : (
					<p className="hub-muted">Checks not run · no execution receipts recorded.</p>
				)}
			</section>
			{state.error && (
				<p className="hub-error" role="alert">
					{state.error}
				</p>
			)}
			<div className="hub-actions">
				{fix.reviewedAt ? (
					<p className="hub-muted">
						Reviewed locally ·{" "}
						<time dateTime={fix.reviewedAt}>{new Date(fix.reviewedAt).toLocaleString()}</time>
					</p>
				) : (
					<button
						type="button"
						disabled={!canReview}
						onClick={() => {
							if (canReview && fix.headSha) void controller.markReviewed(fix.id, fix.headSha);
						}}
					>
						Mark fix reviewed
					</button>
				)}
				{["preparing", "prepared", "executing", "needs-input"].includes(fix.phase) && (
					<button
						type="button"
						className="quiet"
						disabled={state.busy}
						onClick={() => void controller.cancel(fix.id)}
					>
						Stop preparation
					</button>
				)}
			</div>
			<p className="hub-muted">
				This marker stays local. The candidate is not applied or published.
			</p>
		</article>
	);
}

export function PRFixView({
	controller,
	selectedId,
	onNavigate,
	command,
}: {
	controller: PRFixController;
	selectedId?: string;
	onNavigate(target: string): void;
	command: Command;
}) {
	const state = useStore(controller.store);
	useEffect(() => {
		if (selectedId && controller.store.getState().loadedTarget !== selectedId)
			void controller.ensureTarget(selectedId).catch(() => {});
	}, [controller, selectedId]);
	return (
		<div
			className="hub-center pr-fix-center"
			data-center-section="fixes"
			data-selected-id={selectedId}
		>
			{!selectedId ? (
				<>
					<h1>Suggested fixes</h1>
					<p className="hub-muted">
						{state.items.length
							? "Choose a suggested fix in the sidebar to inspect its original feedback and local candidate."
							: "Prepare a suggested fix from an original PR feedback item. Local candidates will appear in the sidebar."}
					</p>
				</>
			) : state.loadedTarget === selectedId && state.detail && !state.detailError ? (
				<PRFixReview
					key={`${state.detail.fix.id}:${state.detail.fix.headSha}`}
					detail={state.detail}
					controller={controller}
					selectedPath={state.selectedPath}
					onNavigate={onNavigate}
					command={command}
				/>
			) : (
				<div className="hub-empty">
					<h2>{state.detailError ? "Candidate unavailable" : "Loading suggested fix…"}</h2>
					{state.detailError && (
						<p className="hub-error" role="alert">
							{state.detailError}
						</p>
					)}
					<button
						type="button"
						className="quiet"
						disabled={state.detailLoading}
						onClick={() => void controller.ensureTarget(selectedId).catch(() => {})}
					>
						Refresh candidate
					</button>
				</div>
			)}
		</div>
	);
}
