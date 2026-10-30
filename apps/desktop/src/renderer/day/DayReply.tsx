import { useState } from "react";
import type { DayWorkItem as WorkItem } from "../../shared/contracts/day";
import type { DayController } from "./controller";

export function DayReply({
	item,
	controller,
	busy,
}: { item: WorkItem; controller: DayController; busy: boolean }) {
	const [body, setBody] = useState(item.replyDraft?.body ?? "");
	if (
		!item.source ||
		["closed", "cancelled"].includes(item.phase) ||
		item.acceptance !== "accepted"
	)
		return null;
	return (
		<section className="day-section" aria-label="Answer to source">
			<h2>Answer to the source thread</h2>
			<p className="day-hint">The commitment closes after a delivered answer is recorded.</p>
			{item.replyDraft && (
				<>
					<p className="day-exact-text">{item.replyDraft.body}</p>
					<button
						type="button"
						disabled={busy || item.phase !== "awaiting_reply"}
						onClick={() => {
							if (!item.replyDraft) return;
							void controller.operate({
								kind: "send_reply",
								itemId: item.id,
								expectedRevision: item.revision,
								draftRevision: item.replyDraft.revision,
								body: item.replyDraft.body,
							});
						}}
					>
						Send this exact reply to source
					</button>
				</>
			)}
			<details>
				<summary>{item.replyDraft ? "Edit reply" : "Type a reply draft"}</summary>
				<form
					className="day-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (busy || !body.trim()) return;
						void controller.operate({
							kind: "draft_reply",
							itemId: item.id,
							expectedRevision: item.revision,
							body: body.trim(),
						});
					}}
				>
					<label>
						Reply draft
						<textarea
							required
							maxLength={40000}
							value={body}
							onChange={(event) => setBody(event.target.value)}
						/>
					</label>
					<button type="submit" disabled={busy || !body.trim()}>
						Save reply draft
					</button>
				</form>
			</details>
		</section>
	);
}
