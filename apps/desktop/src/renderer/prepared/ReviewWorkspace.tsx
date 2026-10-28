import { type ButtonHTMLAttributes, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { PreparedController } from "./controller";
import { patchLines, sourceLines } from "./diff";
import {
	type HighlightedReview,
	type SyntaxToken,
	highlightReviewFile,
	patchLineTokens,
	sourceLineTokens,
} from "./highlighting";

/** React escapes source text; token colors/styles come only from the bundled theme. */
export function SyntaxText({ text, tokens }: { text: string; tokens?: SyntaxToken[] }) {
	if (
		!tokens ||
		tokens.map((token) => token.content).join("") !== text ||
		!tokens.some((token) => token.color)
	)
		return <>{text}</>;
	let offset = 0;
	return (
		<>
			{tokens
				.filter((token) => token.content.length > 0)
				.map((token) => {
					const start = offset;
					offset += token.content.length;
					const flags = Math.max(0, token.fontStyle ?? 0);
					return (
						<span
							className="syntax-token"
							key={start}
							style={{
								color: token.color,
								fontStyle: flags & 1 ? "italic" : undefined,
								fontWeight: flags & 2 ? 600 : undefined,
								textDecorationLine: flags & 4 ? "underline" : undefined,
							}}
						>
							{token.content}
						</span>
					);
				})}
		</>
	);
}

/** Remove redundant labels only; retain uncertainty and every substantive word. */
export function cleanExplanation(text: string) {
	return text.trim().replace(/^(?:inferred(?: summary)?\s*:\s*)+/i, "");
}

export function explanationPreview(text: string) {
	const clean = cleanExplanation(text);
	if (clean.length <= 170) return clean;
	const sentence = clean.slice(0, 170).match(/^.*?[.!?](?=\s)/)?.[0];
	if (sentence) return sentence;
	const boundary = clean.lastIndexOf(" ", 167);
	return `${clean.slice(0, boundary > 60 ? boundary : 167)}…`;
}

export function CompactExplanation({ label, text }: { label: string; text: string }) {
	return (
		<details className="compact-explanation">
			<summary>
				<span className="explanation-label">{label}</span>
				<span className="explanation-preview">{explanationPreview(text)}</span>
			</summary>
			<div className="explanation-full">{cleanExplanation(text)}</div>
		</details>
	);
}

/** Only explicit review controls interrupt narration; observing agent-driven state never does. */
export function ReviewActionButton({
	onInteraction,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { onInteraction?: () => void }) {
	return (
		<button
			{...props}
			onClick={(event) => {
				if (props.disabled) return;
				onInteraction?.();
				props.onClick?.(event);
			}}
		/>
	);
}

export function ReviewWorkspace({
	controller,
	onInteraction,
}: { controller: PreparedController; onInteraction(): void }) {
	const state = useStore(controller.store);
	const [view, setView] = useState<"diff" | "base" | "head">("diff");
	const content = useRef<HTMLDivElement>(null);
	const plan = state.detail?.prepared;
	const file = state.file;
	const [highlighted, setHighlighted] = useState<HighlightedReview | null>(null);
	const syntax = highlighted?.file === file ? highlighted : null;
	useEffect(() => {
		let current = true;
		if (file)
			void highlightReviewFile(file)
				.then((result) => {
					if (current) setHighlighted(result);
				})
				.catch(() => {});
		return () => {
			current = false;
		};
	}, [file]);
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
			data-syntax-state={file ? (syntax ? "ready" : "loading") : undefined}
		>
			<header className="prepared-heading">
				<div>
					<strong title={file?.path}>{file?.path ?? "Opening review…"}</strong>
				</div>
				<ReviewActionButton
					type="button"
					className="quiet"
					onInteraction={onInteraction}
					onClick={controller.close}
				>
					Close review
				</ReviewActionButton>
			</header>
			{state.reviewError && (
				<p className="review-error" role="alert">
					{state.reviewError}
				</p>
			)}
			<div className="review-navigation">
				<ReviewActionButton
					type="button"
					onInteraction={onInteraction}
					disabled={state.fileBusy || state.stale || index <= 0}
					onClick={() => void controller.move(-1)}
				>
					Back
				</ReviewActionButton>
				<span className="tour-progress">
					{index >= 0 ? `File ${index + 1} of ${plan?.files.length}` : "—"}
				</span>
				<ReviewActionButton
					type="button"
					onInteraction={onInteraction}
					disabled={
						state.fileBusy || state.stale || index < 0 || index >= (plan?.files.length ?? 0) - 1
					}
					onClick={() => void controller.move(1)}
				>
					Next
				</ReviewActionButton>
				<ReviewActionButton
					type="button"
					onInteraction={onInteraction}
					className="pause-review"
					disabled={state.fileBusy || state.stale || !file}
					onClick={() => {
						void controller.pause(!state.paused);
					}}
				>
					{state.paused ? "Resume review" : "Pause review"}
				</ReviewActionButton>
				<span className="review-pause-state">{state.paused ? "Paused" : "Guided review"}</span>
			</div>
			{state.fileBusy && <output className="review-loading">Loading pinned source…</output>}
			{note && (
				<div className="file-explanations" key={`${plan?.id}:${note.path}`}>
					<CompactExplanation label="What changes" text={note.summary} />
					<CompactExplanation label="Why this file now" text={note.reason} />
				</div>
			)}
			{file && (
				<>
					<nav className="source-tabs" aria-label="File view">
						{(["diff", "base", "head"] as const).map((tab) => (
							<ReviewActionButton
								type="button"
								onInteraction={view === tab ? undefined : onInteraction}
								key={tab}
								aria-pressed={view === tab}
								onClick={() => setView(tab)}
							>
								{{ diff: "Changes", base: "Before", head: "After" }[tab]}
							</ReviewActionButton>
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
												<code>
													<SyntaxText
														text={line.text}
														tokens={file ? patchLineTokens(syntax, file, line) : undefined}
													/>
												</code>
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
											<code>
												<SyntaxText
													text={text}
													tokens={
														file ? sourceLineTokens(syntax, file, view, line, text) : undefined
													}
												/>
											</code>
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
			{plan && (
				<details className="review-details" key={plan.id}>
					<summary>
						<span>Overview & reading order</span>
						<span className="review-evidence-label">
							Source inference ·{" "}
							{plan.coverage === "partial" ? "Partial coverage" : "Coverage & evidence"}
						</span>
					</summary>
					<section
						className="review-details-scroll"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the complete overview before the reading-order buttons.
						tabIndex={0}
						aria-label="Review overview, reading order and evidence"
					>
						<section aria-label="Review overview">
							<h3>Overview</h3>
							<p>{cleanExplanation(plan.summary)}</p>
						</section>
						<section aria-label="Reading order">
							<h3>Reading order · {plan.files.length} files</h3>
							<p>{cleanExplanation(plan.orderRationale)}</p>
							<ol>
								{plan.files.map((entry) => (
									<li key={entry.path}>
										<ReviewActionButton
											type="button"
											onInteraction={entry.path === file?.path ? undefined : onInteraction}
											className="quiet"
											aria-current={entry.path === file?.path ? "step" : undefined}
											disabled={state.fileBusy || state.stale}
											onClick={() => {
												if (entry.path !== file?.path) void controller.showPath(entry.path);
											}}
										>
											{entry.path}
										</ReviewActionButton>
										<p>{cleanExplanation(entry.reason)}</p>
									</li>
								))}
							</ol>
						</section>
						<section aria-label="Coverage and evidence">
							<h3>Coverage & evidence</h3>
							<p>
								{plan.coverage === "partial"
									? "Partial coverage: some files or patch content were unavailable during preparation."
									: "All changed-file patches were available during preparation."}{" "}
								Explanations are inferred from GitHub source; they are not verified author intent.
								Preparation does not run tests.
							</p>
						</section>
						{note && (
							<section aria-label="Suggested comments">
								<h3>Suggested comments · {note.suggestedComments.length}</h3>
								<span className="inference-label">Inferred drafts · not posted</span>
								{note.suggestedComments.length ? (
									note.suggestedComments.map((comment) => (
										<div className="suggestion-draft" key={comment.id}>
											<p>{comment.body}</p>
											{comment.location && (
												<small>
													{comment.location.path}:{comment.location.startLine}–
													{comment.location.endLine}
												</small>
											)}
										</div>
									))
								) : (
									<p className="small">No comments suggested for this file.</p>
								)}
							</section>
						)}
					</section>
				</details>
			)}
		</section>
	);
}
