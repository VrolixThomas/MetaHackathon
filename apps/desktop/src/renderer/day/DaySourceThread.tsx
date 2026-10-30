import type { ChatMessage } from "../../shared/contracts/chat";
import type { DayWorkItem } from "../../shared/contracts/day";
import type { WorkspaceCommand } from "../../shared/contracts/workspace";
import { checkpointLabel, sameSourceThread } from "./model";

/** Main revalidates source access before supplying exact thread messages. */
export interface DayThreadState {
	itemId: string;
	expectedRevision: number;
	loading: boolean;
	error: boolean;
	messages: ChatMessage[] | null;
}

export function DaySourceThread({
	item,
	thread,
	onLoad,
	command,
}: {
	item: DayWorkItem;
	thread?: DayThreadState;
	onLoad?(id: string, expectedRevision: number): void;
	command(input: WorkspaceCommand): void;
}) {
	if (!item.source)
		return (
			<p className="day-hint">Captured directly in Muse. No external source thread is linked.</p>
		);
	const source = item.source.source;
	const permalink = source.permalink;
	const current =
		thread?.itemId === item.id && thread.expectedRevision === item.revision ? thread : undefined;
	const mismatch = current?.messages?.some((message) => !sameSourceThread(item, message));
	return (
		<section className="day-section" aria-label="Source thread">
			<h2>Source thread</h2>
			{permalink && (
				<button
					type="button"
					className="quiet"
					onClick={() => command({ kind: "open-browser", url: permalink })}
				>
					Open source in Slack ↗
				</button>
			)}
			<details>
				<summary>Read source context</summary>
				{onLoad && (
					<button
						type="button"
						className="quiet"
						disabled={current?.loading}
						onClick={() => onLoad(item.id, item.revision)}
					>
						{current?.messages ? "Refresh source thread" : "Load source thread"}
					</button>
				)}
				{current?.loading ? (
					<p aria-live="polite">Loading source thread…</p>
				) : current?.error || mismatch ? (
					<p role="alert">Source context is unavailable. Open the original thread to check it.</p>
				) : current?.messages ? (
					current.messages.length ? (
						current.messages.map((message) => (
							<blockquote
								className="day-source-message"
								key={message.citation.source.messageId}
								data-source-message={message.citation.source.messageId}
								data-source-revision={message.citation.source.revisionId}
							>
								<p>{message.deletedAt ? "Message deleted" : message.text}</p>
								<footer>
									{message.authorId} ·{" "}
									<time dateTime={message.createdAt}>{checkpointLabel(message.createdAt)}</time>
									{message.truncated ? " · Source text is truncated" : ""}
								</footer>
							</blockquote>
						))
					) : (
						<p className="day-hint">No readable messages were returned for this thread.</p>
					)
				) : (
					<p className="day-hint">Read the original thread for its source text.</p>
				)}
				<dl className="day-source-identity">
					<dt>Workspace</dt>
					<dd>{source.workspaceId}</dd>
					<dt>Conversation</dt>
					<dd>{source.conversationId}</dd>
					<dt>Thread</dt>
					<dd>{source.threadId ?? source.messageId}</dd>
					<dt>Captured message</dt>
					<dd>{source.messageId}</dd>
					<dt>Source revision</dt>
					<dd>{source.revisionId}</dd>
				</dl>
			</details>
		</section>
	);
}
