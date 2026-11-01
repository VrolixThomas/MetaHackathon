import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import {
	type ChatMessage,
	decodeSlackViewTarget,
	encodeSlackViewTarget,
} from "../../shared/contracts/chat";
import type { SlackBrowseController } from "./controller";
import { conversationSymbol, slackPlainText, visibilityLabel } from "./presentation";

export interface SlackConversationViewProps {
	controller: SlackBrowseController;
	selectedId?: string;
	/** Root must execute open-center through workspace.command; the view never changes selection. */
	onNavigate(targetId: string): void;
	/** Optional root interruption/presentation hook for explicit in-place reads. */
	beforeNavigate?(): void | Promise<void>;
}

const dayLabel = (value: string) =>
	new Date(value).toLocaleDateString(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
	});
const timeLabel = (value: string) =>
	new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function SlackConversationView({
	controller,
	selectedId,
	onNavigate,
	beforeNavigate,
}: SlackConversationViewProps) {
	const state = useStore(controller.store);
	const [readError, setReadError] = useState<{ target?: string; message: string } | null>(null);
	const scroll = useRef<HTMLDivElement>(null);
	const anchor = useRef<{ height: number; top: number } | null>(null);
	const lastTarget = useRef<string | null>(null);
	const shown = !!selectedId && state.loadedTarget === selectedId && !!state.conversation;
	let target: ReturnType<typeof decodeSlackViewTarget> | undefined;
	try {
		if (selectedId) target = decodeSlackViewTarget(selectedId);
	} catch {
		/* The controller supplies the error; this view cannot establish a target. */
	}
	const isThread = !!target?.threadTs;
	useLayoutEffect(() => {
		const element = scroll.current;
		if (!element || !shown) {
			lastTarget.current = null;
			anchor.current = null;
			return;
		}
		if (anchor.current && !state.olderLoading) {
			element.scrollTop = anchor.current.top + element.scrollHeight - anchor.current.height;
			anchor.current = null;
		} else if (lastTarget.current !== selectedId) {
			element.scrollTop = isThread ? 0 : element.scrollHeight;
		}
		lastTarget.current = selectedId ?? null;
	}, [shown, selectedId, isThread, state.olderLoading]);

	async function read(older: boolean) {
		setReadError(null);
		try {
			await beforeNavigate?.();
			// A delayed root hook must not refresh a newly selected source.
			if (controller.store.getState().target !== selectedId) return;
			if (older && scroll.current)
				anchor.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop };
			await (older ? controller.loadOlder() : controller.refreshCurrent());
		} catch {
			setReadError({ target: selectedId, message: "The reader could not refresh. Try again." });
		}
	}
	const matchingError =
		state.target === selectedId || state.target === null ? state.messageError : "";
	if (!selectedId)
		return (
			<div className="slack-reader slack-reader-empty">
				<span className="slack-empty-symbol" aria-hidden="true">
					#
				</span>
				<h1>Your Slack, in MuseFocus</h1>
				<p>Select a channel or direct message in the sidebar.</p>
				<p className="slack-muted">
					Messages and threads open here. Your conversation with MuseFocus stays available.
				</p>
			</div>
		);
	if (!shown || !state.conversation)
		return (
			<div className="slack-reader slack-reader-empty" aria-busy={state.messageLoading}>
				<h1>{matchingError || !target ? "Conversation unavailable" : "Loading conversation…"}</h1>
				<p role={matchingError ? "alert" : "status"}>
					{matchingError ||
						(!target
							? "Choose a valid Slack conversation in the sidebar."
							: "Reading messages from your current Slack connection.")}
				</p>
				{target && matchingError && (
					<button
						type="button"
						disabled={state.messageLoading}
						onClick={() => onNavigate(selectedId)}
					>
						Retry conversation
					</button>
				)}
			</div>
		);

	return (
		<section
			className="slack-reader"
			aria-label={isThread ? "Slack thread" : "Slack conversation"}
			data-slack-target={selectedId}
		>
			<header className="slack-reader-header">
				<div className="slack-reader-heading">
					<span className="slack-reader-symbol" aria-hidden="true">
						{conversationSymbol(state.conversation)}
					</span>
					<div>
						<h1>{state.conversation.name}</h1>
						<p>
							{visibilityLabel(state.conversation)}
							{isThread ? " · Thread" : ""}
						</p>
					</div>
				</div>
				<button
					type="button"
					className="quiet"
					disabled={state.messageLoading || state.olderLoading}
					onClick={() => void read(false)}
				>
					Refresh
				</button>
			</header>
			{isThread && target && (
				<div className="slack-thread-bar">
					<strong>Thread</strong>
					<button
						type="button"
						className="quiet"
						onClick={() =>
							onNavigate(
								encodeSlackViewTarget({ conversationId: target.conversationId, threadTs: null })
							)
						}
					>
						← Back to conversation
					</button>
				</div>
			)}
			{readError?.target === selectedId && (
				<p className="slack-feedback" role="alert">
					{readError.message}
				</p>
			)}
			{state.messageError && (
				<p className="slack-feedback" role="alert">
					{state.messageError}
				</p>
			)}
			<div className="slack-message-scroll" ref={scroll} aria-busy={state.olderLoading}>
				<div className="slack-message-window">
					{!isThread && state.messageHasMore && (
						<div className="slack-history-action">
							<button
								type="button"
								className="quiet"
								disabled={state.olderLoading}
								onClick={() => void read(true)}
							>
								{state.olderLoading ? "Loading older messages…" : "Load older messages"}
							</button>
						</div>
					)}
					{!state.messages.length && (
						<div className="slack-no-messages">
							<h2>{isThread ? "No thread messages returned" : "No messages returned"}</h2>
							<p>Refresh to check this {isThread ? "thread" : "conversation"} again.</p>
						</div>
					)}
					{state.messages.map((message, index) => {
						const previous = state.messages[index - 1];
						return (
							<Fragment key={message.citation.source.messageId}>
								{(!previous || dayLabel(previous.createdAt) !== dayLabel(message.createdAt)) && (
									<div className="slack-date-divider">
										<span>{dayLabel(message.createdAt)}</span>
									</div>
								)}
								<SlackMessage
									message={message}
									authors={state.authors}
									onThread={
										!isThread && target
											? () =>
													onNavigate(
														encodeSlackViewTarget({
															conversationId: target.conversationId,
															threadTs:
																message.citation.source.threadId ??
																message.citation.source.messageId,
														})
													)
											: undefined
									}
								/>
							</Fragment>
						);
					})}
					{isThread && state.messageHasMore && (
						<div className="slack-history-action">
							<button
								type="button"
								className="quiet"
								disabled={state.olderLoading}
								onClick={() => void read(true)}
							>
								{state.olderLoading ? "Loading…" : "Load more thread messages"}
							</button>
						</div>
					)}
				</div>
			</div>
			<footer className="slack-reader-footer">
				Read-only · {state.messages.length} message{state.messages.length === 1 ? "" : "s"} loaded
				{state.messageHasMore ? " · More available" : ""}
			</footer>
		</section>
	);
}

function SlackMessage({
	message,
	authors,
	onThread,
}: { message: ChatMessage; authors: Record<string, string>; onThread?: () => void }) {
	const author = Object.hasOwn(authors, message.authorId)
		? (authors[message.authorId] ?? message.authorId)
		: message.authorId;
	return (
		<article className="slack-message" data-slack-message={message.citation.source.messageId}>
			<div className="slack-author-initial" aria-hidden="true">
				{author.slice(0, 2).toLocaleUpperCase()}
			</div>
			<div className="slack-message-content">
				<div className="slack-message-meta">
					<strong title={message.authorId}>{author}</strong>
					<time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>
						{timeLabel(message.createdAt)}
					</time>
					{!message.deletedAt && message.updatedAt !== message.createdAt && (
						<span title={message.updatedAt}>edited</span>
					)}
				</div>
				<p
					className={
						message.deletedAt ? "slack-message-text slack-message-deleted" : "slack-message-text"
					}
				>
					{message.deletedAt ? "Message deleted" : slackPlainText(message.text, authors)}
				</p>
				{!message.deletedAt && !message.text && (
					<p className="slack-truncated">No plain text was returned for this message.</p>
				)}
				{message.truncated && !message.deletedAt && (
					<p className="slack-truncated">Message text is truncated at the source.</p>
				)}
				{onThread && !message.deletedAt && (
					<button type="button" className="slack-thread-link quiet" onClick={onThread}>
						View thread <span aria-hidden="true">↗</span>
					</button>
				)}
			</div>
		</article>
	);
}
