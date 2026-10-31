import { useEffect, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import type { PreparedController } from "../prepared/controller";
import { WorkspaceDialog } from "../workspace/WorkspaceDialog";
import { type PRCommentCall, createPRCommentApi } from "./api";
import { preparedCommentContext } from "./context";
import { type PRCommentController, createPRCommentController } from "./controller";
import "./pr-comments.css";

export function PRCommentButton({
	controller,
	reviews,
}: {
	controller: PRCommentController;
	reviews: PreparedController;
}) {
	const review = useStore(reviews.store);
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot
	);
	const context = preparedCommentContext(review);
	if (!context && !state.open && !state.request) return null;
	return (
		<button
			type="button"
			aria-haspopup="dialog"
			aria-expanded={state.open}
			disabled={!context && !state.request}
			onClick={controller.open}
		>
			{state.request ? "View PR comment" : "Add PR comment"}
		</button>
	);
}

/** The checkbox and button refer to the immutable, exact server-returned draft below. */
export function PRCommentComposer({
	controller,
	beforeOpen,
	onOpenError,
}: {
	controller: PRCommentController;
	beforeOpen?: () => Promise<void>;
	onOpenError?: () => void;
}) {
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot
	);
	if (!state.open) return null;
	const { draft, context } = state;
	const composing = state.phase === "compose" || state.phase === "saving";
	const pr = state.draftPr ?? context?.pr;
	const location = draft?.location;
	const busy = state.phase === "saving" || state.phase === "posting";
	return (
		<WorkspaceDialog
			id="pr-comment-composer"
			title="PR comment"
			position="right"
			className="pr-comment-dialog"
			beforeOpen={beforeOpen}
			onClose={controller.close}
			onOpenError={() => {
				controller.close();
				onOpenError?.();
			}}
		>
			<div
				className="pr-comment-composer"
				data-comment-phase={state.phase}
				data-comment-draft-id={draft?.id}
				data-comment-draft-revision={draft?.revision}
				data-comment-head={draft?.headSha}
			>
				{pr && (
					<p className="pr-comment-target">
						{pr.repository} #{pr.number}
						<br />
						Head <code>{draft?.headSha ?? pr.headSha}</code>
					</p>
				)}
				{!context && (
					<p role="alert">Reopen the current prepared review before confirming this comment.</p>
				)}
				{composing ? (
					<>
						<label htmlFor="pr-comment-body">Comment</label>
						<textarea
							id="pr-comment-body"
							rows={8}
							value={state.body}
							maxLength={20000}
							disabled={busy || !context}
							onChange={(event) => controller.setBody(event.target.value)}
						/>
						<label htmlFor="pr-comment-line">Head-side diff line (optional)</label>
						<input
							id="pr-comment-line"
							type="number"
							min={1}
							step={1}
							value={state.line}
							disabled={busy || !context}
							onChange={(event) => controller.setLine(event.target.value)}
							aria-describedby="pr-comment-line-help"
						/>
						<p className="small" id="pr-comment-line-help">
							{context?.file.path}. Leave blank for a general PR comment. An inline comment attaches
							to one line in the current head-side diff.
						</p>
						<button
							type="button"
							disabled={busy || !context || !state.body.trim()}
							onClick={() => void controller.review()}
						>
							{state.phase === "saving" ? "Preparing…" : "Review comment"}
						</button>
					</>
				) : (
					draft && (
						<>
							<p>
								{location ? `${location.path}:${location.endLine} · Head` : "General PR comment"} ·
								Draft revision {draft.revision}
							</p>
							<pre className="pr-comment-exact" aria-label="Exact comment body">
								{draft.body}
							</pre>
							{state.phase !== "posted" && (
								<>
									<label className="pr-comment-consent">
										<input
											type="checkbox"
											checked={state.consent}
											disabled={!controller.canConfirm()}
											onChange={(event) => controller.setConsent(event.target.checked)}
										/>
										<span>
											I confirm posting this exact comment
											{pr ? ` to ${pr.repository} #${pr.number}` : ""} at head{" "}
											<code>{draft.headSha}</code>.
										</span>
									</label>
									<div className="pr-comment-actions">
										<button
											type="button"
											disabled={!state.consent || !controller.canConfirm()}
											onClick={() => void controller.post()}
										>
											{state.phase === "posting"
												? "Posting…"
												: state.request
													? "Retry same request"
													: "Post comment to GitHub"}
										</button>
										{!state.request && (
											<button type="button" className="quiet" onClick={controller.edit}>
												Edit comment
											</button>
										)}
									</div>
								</>
							)}
						</>
					)
				)}
				{state.error && (
					<p className="review-error" role="alert">
						{state.error}
					</p>
				)}
				{state.notice && <output>{state.notice}</output>}
				{state.url && (
					<a href={state.url} target="_blank" rel="noreferrer">
						View posted comment on GitHub
					</a>
				)}
				{state.phase === "posted" && context && (
					<button type="button" onClick={controller.newComment}>
						Write another comment
					</button>
				)}
				{state.phase !== "posted" && (
					<button type="button" className="quiet" onClick={controller.close}>
						{state.request ? "Close / request cancellation" : "Cancel"}
					</button>
				)}
			</div>
		</WorkspaceDialog>
	);
}

/** Mount once in the default app's review controls, outside the legacy fixture UI. */
export function PRCommentControl({
	call,
	reviews,
	beforeOpen,
	onOpenError,
	onOpenChange,
	onController,
}: {
	call: PRCommentCall;
	reviews: PreparedController;
	beforeOpen?: () => Promise<void>;
	onOpenError?: () => void;
	onOpenChange?: (open: boolean) => void;
	/** Root binds foreground effects to this same persistent composer instance. */
	onController?: (controller: PRCommentController | null) => void;
}) {
	const [controller] = useState(() =>
		createPRCommentController(createPRCommentApi(call), () =>
			preparedCommentContext(reviews.store.getState())
		)
	);
	const open = useSyncExternalStore(
		controller.subscribe,
		() => controller.getSnapshot().open,
		() => false
	);
	useEffect(() => {
		onController?.(controller);
		return () => onController?.(null);
	}, [controller, onController]);
	useEffect(() => {
		onOpenChange?.(open);
		return () => onOpenChange?.(false);
	}, [open, onOpenChange]);
	useEffect(() => {
		const unsubscribe = reviews.store.subscribe(controller.refreshContext);
		controller.refreshContext();
		return () => {
			unsubscribe();
			controller.dispose();
		};
	}, [controller, reviews]);
	return (
		<>
			<PRCommentButton controller={controller} reviews={reviews} />
			<PRCommentComposer
				controller={controller}
				beforeOpen={beforeOpen}
				onOpenError={onOpenError}
			/>
		</>
	);
}
