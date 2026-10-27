import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { PreparedController } from "./controller";
import { patchLines, sourceLines } from "./diff";

export function ReviewWorkspace({
	controller,
	onPause,
}: { controller: PreparedController; onPause(): void }) {
	const state = useStore(controller.store);
	const [view, setView] = useState<"diff" | "base" | "head">("diff");
	const content = useRef<HTMLDivElement>(null);
	const plan = state.detail?.prepared;
	const file = state.file;
	const index = plan?.files.findIndex((entry) => entry.path === file?.path) ?? -1;
	const note = plan?.files[index];
	useEffect(() => {
		if (state.highlight) setView(state.highlight.revision);
	}, [state.highlight]);
	useEffect(() => {
		if (!file) return;
		if (state.highlight && view === state.highlight.revision)
			content.current?.querySelector(".source-selected")?.scrollIntoView({ block: "center" });
		else content.current?.scrollTo({ top: 0 });
	}, [file, state.highlight, view]);
	const source = file && view !== "diff" ? file[view] : null;
	const rows =
		source?.content !== null && source?.content !== undefined ? sourceLines(source.content) : [];
	const start =
		rows.length > 3000 && state.highlight?.revision === view
			? Math.max(0, state.highlight.startLine - 100)
			: 0;
	const shown = rows.slice(start, start + 3000);
	const changes = file?.patch ? patchLines(file.patch) : [];
	return (
		<section
			className="prepared-workspace"
			aria-label="Prepared review"
			data-review-id={plan?.id}
			data-review-path={file?.path}
			data-screen-sequence={state.screen.sequence}
			data-review-paused={state.paused}
			data-review-loading={state.fileBusy}
			data-review-progress-path={state.detail?.progress?.path ?? ""}
			data-base-sha={plan?.pr.baseSha}
			data-head-sha={plan?.pr.headSha}
		>
			<header className="prepared-heading">
				<div>
					<span>
						{state.detail?.pr.repository} {state.detail ? `#${state.detail.pr.number}` : ""}
					</span>
					<strong>{state.detail?.pr.title ?? "Opening review…"}</strong>
				</div>
				<button type="button" className="quiet" onClick={controller.close}>
					Back to chat
				</button>
			</header>
			{state.reviewError && (
				<p className="review-error" role="alert">
					{state.reviewError}
				</p>
			)}
			{plan && (
				<details className="reading-plan">
					<summary>
						Reading order · {plan.files.length} files{" "}
						{plan.coverage === "partial" ? "· Partial coverage" : ""}
					</summary>
					<p>{plan.summary}</p>
					<p>{plan.orderRationale}</p>
					<span className="inference-label">
						Inferred from GitHub source · not executed verification
					</span>
					<ol>
						{plan.files.map((entry) => (
							<li key={entry.path}>
								<button
									type="button"
									className="quiet"
									aria-current={entry.path === file?.path ? "step" : undefined}
									disabled={state.fileBusy || state.stale}
									onClick={() => void controller.showPath(entry.path)}
								>
									{entry.path}
								</button>
								<p>{entry.reason}</p>
							</li>
						))}
					</ol>
				</details>
			)}
			<div className="review-navigation">
				<button
					type="button"
					disabled={state.fileBusy || state.stale || index <= 0}
					onClick={() => void controller.move(-1)}
				>
					Back
				</button>
				<span>{index >= 0 ? `${index + 1} / ${plan?.files.length}` : "—"}</span>
				<button
					type="button"
					disabled={
						state.fileBusy || state.stale || index < 0 || index >= (plan?.files.length ?? 0) - 1
					}
					onClick={() => void controller.move(1)}
				>
					Next
				</button>
				<button
					type="button"
					className="pause-review"
					disabled={state.fileBusy || state.stale || !file}
					onClick={() => {
						if (!state.paused) onPause();
						void controller.pause(!state.paused);
					}}
				>
					{state.paused ? "Resume review" : "Pause review"}
				</button>
				<span className="review-pause-state">{state.paused ? "Paused" : "Guided review"}</span>
			</div>
			{state.fileBusy && <output className="review-loading">Loading pinned source…</output>}
			{note && (
				<div className="file-explanation">
					<strong>{note.path}</strong>
					<p>{note.summary}</p>
					<span className="inference-label">Inferred summary</span>
				</div>
			)}
			{file && (
				<>
					<nav className="source-tabs" aria-label="File view">
						{(["diff", "base", "head"] as const).map((tab) => (
							<button
								type="button"
								key={tab}
								aria-pressed={view === tab}
								onClick={() => setView(tab)}
							>
								{{ diff: "Changes", base: "Before", head: "After" }[tab]}
							</button>
						))}
						<span>
							{view === "base"
								? file.base.commitSha.slice(0, 8)
								: view === "head"
									? file.head.commitSha.slice(0, 8)
									: `${file.base.commitSha.slice(0, 8)} → ${file.head.commitSha.slice(0, 8)}`}
						</span>
					</nav>
					<div className="real-source" ref={content} aria-label="Pinned file source">
						{view === "diff" ? (
							file.patch ? (
								<>
									<div className="patch-lines">
										{changes.slice(0, 3000).map((line, i) => (
											<div
												className={`patch-row ${line.kind}`}
												key={`${i}-${line.base}-${line.head}`}
											>
												<span className="line-number">{line.base}</span>
												<span className="line-number">{line.head}</span>
												<code>{line.text}</code>
											</div>
										))}
									</div>
									{changes.length > 3000 && (
										<p className="source-notice">
											Showing the first 3,000 patch lines. Use Before or After to inspect source.
										</p>
									)}
								</>
							) : (
								<p className="source-notice">
									No text patch was supplied. Use Before or After to inspect available source.
								</p>
							)
						) : source?.status === "available" ? (
							<>
								{shown.map((text, offset) => {
									const line = start + offset + 1;
									const selected =
										state.highlight?.revision === view &&
										line >= state.highlight.startLine &&
										line <= state.highlight.endLine;
									return (
										<div className={`source-row ${selected ? "source-selected" : ""}`} key={line}>
											<span className="line-number">{line}</span>
											<code>{text}</code>
										</div>
									);
								})}
								{!rows.length && <p className="source-notice">This file is empty.</p>}
								{rows.length > shown.length && (
									<p className="source-notice">
										Showing lines {start + 1}–{start + shown.length} of {rows.length}.
									</p>
								)}
							</>
						) : (
							<p className="source-notice">
								{source?.status === "missing"
									? "This file does not exist at this revision."
									: source?.status === "binary"
										? "Binary source is not displayed as text."
										: "This source exceeds the display limit."}
							</p>
						)}
					</div>
				</>
			)}
			{!file && !state.fileBusy && (
				<div className="source-notice">
					{plan?.files.length === 0
						? "The prepared plan contains no files."
						: "Select a prepared file to inspect its source."}
				</div>
			)}
			{note && (
				<details className="suggested-comments">
					<summary>Suggested comments · {note.suggestedComments.length}</summary>
					<span className="inference-label">Inferred drafts · not posted</span>
					{note.suggestedComments.length ? (
						note.suggestedComments.map((comment) => (
							<div className="suggestion-draft" key={comment.id}>
								<p>{comment.body}</p>
								{comment.location && (
									<small>
										{comment.location.path}:{comment.location.startLine}–{comment.location.endLine}
									</small>
								)}
							</div>
						))
					) : (
						<p className="small">No comments suggested for this file.</p>
					)}
				</details>
			)}
		</section>
	);
}
