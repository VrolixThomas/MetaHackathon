import { useLayoutEffect, useRef } from "react";
import { useStore } from "zustand";
import type { WorkspaceCommand } from "../../shared/contracts/workspace";
import { DayFeedback } from "./DayFeedback";
import { DayQuestions } from "./DayQuestions";
import { DayReply } from "./DayReply";
import { DaySourceThread, type DayThreadState } from "./DaySourceThread";
import type { DayController } from "./controller";
import { checkpointLabel, ownershipLabel, phasePresentation, sourceVisibility } from "./model";

export interface DayWorkItemProps {
	controller: DayController;
	itemId: string;
	/** Uses the existing acknowledged workspace controller, including for source links. */
	command(input: WorkspaceCommand): void;
	/** Root may enter its existing voice conversation after the user's cover action settles. */
	onCoverItem?(id: string): void;
	thread?: DayThreadState;
	onLoadThread?(id: string, expectedRevision: number): void;
	linear?: { id: string; identifier: string; url: string };
}

export function DayWorkItem({
	controller,
	itemId,
	command,
	onCoverItem,
	thread,
	onLoadThread,
	linear,
}: DayWorkItemProps) {
	const { snapshot, busy, error, loading } = useStore(controller.store);
	const visibleItem = useRef<string | null>(itemId);
	useLayoutEffect(() => {
		visibleItem.current = itemId;
		return () => {
			visibleItem.current = null;
		};
	}, [itemId]);
	if (!snapshot)
		return (
			<DayFeedback state={error ? "error" : "loading"} onRetry={() => void controller.refresh()} />
		);
	const item = snapshot.items.find((candidate) => candidate.id === itemId);
	if (!item) return <DayFeedback state="missing" onRetry={() => void controller.refresh()} />;
	const phase = phasePresentation[item.phase];
	const covered = snapshot.currentItemId === item.id;
	const terminal = ["closed", "cancelled"].includes(item.phase);
	const version = { itemId: item.id, expectedRevision: item.revision };
	const jobId = item.jobId;
	const cover = () => {
		void controller.operate({ kind: "cover", ...version }).then((result) => {
			const current = controller.store.getState().snapshot;
			if (
				visibleItem.current === item.id &&
				result?.snapshot.currentItemId === item.id &&
				current?.currentItemId === item.id &&
				current.items.find((row) => row.id === item.id)?.revision ===
					result.snapshot.items.find((row) => row.id === item.id)?.revision
			)
				onCoverItem?.(item.id);
		});
	};
	return (
		<article className="day-item" aria-label="Day work item" aria-busy={loading}>
			<div className="day-item-meta">
				<span className="day-status" data-tone={phase.tone}>
					{phase.label}
				</span>
				<span
					className="day-status"
					data-tone={item.acceptance === "pending" ? "attention" : "quiet"}
				>
					{ownershipLabel(item)}
				</span>
				<span className="day-visibility">{sourceVisibility(item)}</span>
			</div>
			<h1>{item.title}</h1>
			{item.summary && <p className="day-exact-text">{item.summary}</p>}
			<p className="day-priority">
				Why this priority · inferred
				{item.priority.reason ? `: ${item.priority.reason}` : " · No explanation recorded"}
			</p>
			{error && <p role="alert">{error}</p>}
			{snapshot.errors.length > 0 && (
				<p role="alert">
					Some sources or background actions are unavailable. This is the saved work state.
				</p>
			)}
			<section className="day-focus" aria-label="Current focus">
				<h2>{covered && !terminal ? "Covering this item" : "Current focus"}</h2>
				<p>
					{covered && item.phase === "needs_context"
						? "Discuss the missing context with Muse."
						: phase.focus}
				</p>
				{item.acceptance === "pending" && !terminal && (
					<>
						<p className="day-hint">
							Ownership needs your acceptance. Preparation can continue while you decide.
						</p>
						<div className="day-actions">
							<button
								type="button"
								disabled={busy}
								onClick={() => void controller.operate({ kind: "accept", ...version })}
							>
								Accept ownership
							</button>
							<button
								type="button"
								className="quiet"
								disabled={busy}
								onClick={() => void controller.operate({ kind: "decline", ...version })}
							>
								Decline
							</button>
						</div>
					</>
				)}
				<div className="day-actions">
					{!covered && !terminal && (
						<button type="button" disabled={busy} onClick={cover}>
							Cover this item with Muse
						</button>
					)}
					{jobId && (
						<button
							type="button"
							className="quiet"
							onClick={() =>
								command({
									kind: "open-center",
									section: "activity",
									selectedId: jobId,
								})
							}
						>
							{item.phase === "ready_review" ? "Review recorded work" : "Open background work"}
						</button>
					)}
					{linear?.id === item.linearIssueId && (
						<button
							type="button"
							className="quiet"
							onClick={() => command({ kind: "open-browser", url: linear.url })}
						>
							Open {linear.identifier} in Linear ↗
						</button>
					)}
				</div>
				{item.linearIssueId && linear?.id !== item.linearIssueId && (
					<p className="day-hint">Linked Linear issue · {item.linearIssueId}</p>
				)}
			</section>
			{!terminal && (
				<DayQuestions item={item} controller={controller} covered={covered} busy={busy} />
			)}
			<section className="day-checkpoint" aria-label="Next checkpoint">
				<h2>{terminal ? "Outcome" : "Next checkpoint"}</h2>
				{item.answerReceipt ? (
					<p>
						Answer delivered ·{" "}
						<time dateTime={item.answerReceipt.deliveredAt}>
							{checkpointLabel(item.answerReceipt.deliveredAt)}
						</time>
					</p>
				) : item.localAnswerReceipt ? (
					<p>
						Answer confirmed by you ·{" "}
						<time dateTime={item.localAnswerReceipt.confirmedAt}>
							{checkpointLabel(item.localAnswerReceipt.confirmedAt)}
						</time>
					</p>
				) : terminal ? (
					<p className="day-hint">No delivered answer is recorded.</p>
				) : item.nextCheckAt ? (
					<p>
						<time dateTime={item.nextCheckAt}>{checkpointLabel(item.nextCheckAt)}</time>
					</p>
				) : (
					<p className="day-hint">No scheduled checkpoint is recorded.</p>
				)}
				{item.reviewedAt && (
					<p className="day-hint">
						Work reviewed ·{" "}
						<time dateTime={item.reviewedAt}>{checkpointLabel(item.reviewedAt)}</time>
					</p>
				)}
				{snapshot.supervisor !== "running" && !terminal && (
					<p className="day-hint">Background supervision is {snapshot.supervisor}.</p>
				)}
			</section>
			<DaySourceThread item={item} thread={thread} onLoad={onLoadThread} command={command} />
			<DayReply
				key={`${item.id}:${item.replyDraft?.revision ?? 0}`}
				item={item}
				controller={controller}
				busy={busy}
			/>
			{!item.source && !terminal && item.acceptance === "accepted" && (
				<section className="day-section">
					<button
						type="button"
						disabled={
							busy ||
							item.questions.some((question) => question.answer === null) ||
							(!!item.jobId && !item.reviewedAt)
						}
						onClick={() =>
							void controller.operate({
								kind: "confirm_local_answer",
								itemId: item.id,
								expectedRevision: item.revision,
								confirmed: true,
							})
						}
					>
						I have answered this
					</button>
					<p className="day-hint">Records your confirmation; it does not send a message.</p>
				</section>
			)}
		</article>
	);
}
