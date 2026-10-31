import { useEffect, useId, useState } from "react";
import { useStore } from "zustand";
import { decodeSlackViewTarget, encodeSlackViewTarget } from "../../shared/contracts/chat";
import type { SlackBrowseController } from "./controller";
import { conversationSymbol, isDirectMessage, visibilityLabel } from "./presentation";

export interface SlackConversationListProps {
	controller: SlackBrowseController;
	selectedId?: string;
	/** Root must use the acknowledged open-center command, including encoded thread identity. */
	onSelect(targetId: string): void;
}

export function SlackConversationList({
	controller,
	selectedId,
	onSelect,
}: SlackConversationListProps) {
	const state = useStore(controller.store);
	const [search, setSearch] = useState("");
	const searchId = useId();
	useEffect(() => {
		void controller.start();
	}, [controller]);
	let selectedConversation: string | undefined;
	try {
		if (selectedId) selectedConversation = decodeSlackViewTarget(selectedId).conversationId;
	} catch {
		/* Invalid selections are handled by the main reader. */
	}
	const query = search.trim().toLocaleLowerCase();
	const filtered = state.conversations
		.filter((row) => `${row.name} ${row.id}`.toLocaleLowerCase().includes(query))
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	const connected = state.status?.phase === "connected";
	return (
		<div className="slack-list">
			<div className="slack-list-source">
				<span title={state.status?.account?.workspaceId}>
					{state.status?.account?.workspaceName || "Slack"}
				</span>
				<button
					type="button"
					className="quiet"
					disabled={state.listLoading}
					onClick={() => void controller.refreshConversations()}
				>
					{state.listLoading ? "Loading…" : "Refresh"}
				</button>
			</div>
			<label className="slack-search" htmlFor={searchId}>
				<span className="slack-sr-only">Search loaded Slack conversations</span>
				<input
					id={searchId}
					type="search"
					placeholder="Find a conversation…"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</label>
			{state.listError && (
				<p className="slack-feedback" role="alert">
					{state.listError}
				</p>
			)}
			{!state.listLoaded && !state.listError && (
				<p className="slack-feedback" aria-live="polite">
					{state.listLoading
						? "Loading your Slack conversations…"
						: "Refresh to load Slack conversations."}
				</p>
			)}
			{([false, true] as const).map((direct) => {
				const rows = filtered.filter((row) => isDirectMessage(row) === direct);
				return (
					<section
						className="slack-list-group"
						key={String(direct)}
						aria-label={direct ? "Direct messages" : "Channels"}
					>
						<div className="command-group-title">
							<span>{direct ? "Direct messages" : "Channels"}</span>
							<span>{rows.length}</span>
						</div>
						<ul>
							{rows.map((row) => (
								<li key={row.id}>
									<button
										type="button"
										className="slack-conversation-row quiet"
										aria-current={selectedConversation === row.id ? "true" : undefined}
										disabled={!connected || !row.canRead}
										title={`${row.name} · ${visibilityLabel(row)} · ${row.id}`}
										onClick={() =>
											onSelect(encodeSlackViewTarget({ conversationId: row.id, threadTs: null }))
										}
									>
										<span className="slack-conversation-symbol" aria-hidden="true">
											{conversationSymbol(row)}
										</span>
										<span className="slack-conversation-name">{row.name}</span>
										{!row.canRead && <span className="slack-row-unavailable">Unavailable</span>}
									</button>
								</li>
							))}
						</ul>
						{state.listLoaded && !rows.length && (
							<p className="slack-feedback">
								{query
									? "No matches in loaded conversations."
									: direct
										? "No direct messages loaded."
										: "No channels loaded."}
							</p>
						)}
					</section>
				);
			})}
			{state.listLoaded && (
				<div className="slack-list-pagination">
					{state.listHasMore ? (
						<>
							<p>Search covers {state.conversations.length} loaded conversations.</p>
							<button
								type="button"
								className="quiet"
								disabled={state.listLoading}
								onClick={() => void controller.loadMoreConversations()}
							>
								{state.listLoading ? "Loading…" : "Load more conversations"}
							</button>
						</>
					) : (
						<p>
							{state.conversations.length} conversation{state.conversations.length === 1 ? "" : "s"}{" "}
							loaded
						</p>
					)}
				</div>
			)}
		</div>
	);
}
