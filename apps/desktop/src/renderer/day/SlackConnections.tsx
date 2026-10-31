import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createConversationApi } from "../conversation/api";
import { OAuthConnections, useOAuth } from "../oauth";
import { createSlackSourcesController } from "../oauth/slack-sources";

export function SlackConnections() {
	const oauth = useOAuth();
	const controller = useMemo(
		() =>
			createSlackSourcesController(
				createConversationApi((input) => window.electron.trpc.request(input)).call,
				oauth,
				() => window.dispatchEvent(new Event("muse:slack-account-change"))
			),
		[oauth]
	);
	const { status, conversations, cursor, selected, excluded, busy, loginPending, error } = useStore(
		controller.store
	);
	useEffect(() => {
		controller.start();
		return () => controller.dispose();
	}, [controller]);
	return (
		<section className="hub-setup" aria-label="Slack connection">
			<OAuthConnections providers={["slack"]} />
			{error && <p role="alert">{error}</p>}
			{status?.phase === "connected" && (
				<div className="slack-watch-controls" aria-label="Slack watched conversations">
					<h3>
						{status.followMode === "all_joined"
							? "Following your Slack conversations"
							: "Slack conversations"}
					</h3>
					<output data-testid="slack-source-status" aria-live="polite">
						{status.account?.workspaceName} / {status.account?.userName} ·{" "}
						{status.followMode === "all_joined"
							? status.membershipSync?.phase === "capacity"
								? "Conversation discovery reached its current capacity; some conversations are pending."
								: status.membershipSync?.phase === "error"
									? "Conversation discovery needs attention. Existing conversations remain followed."
									: status.membershipSync?.phase === "syncing" ||
											status.membershipSync?.phase === "pending"
										? `Discovering your conversations · ${status.membershipSync.discoveredCount} found`
										: `Following all active channels and DMs you belong to · ${status.watching.length} conversations${excluded.length ? ` · ${excluded.length} excluded` : ""}`
							: status.coverage === "socket"
								? "Live events for watched conversations"
								: status.coverage === "paused"
									? "Watching paused"
									: status.watching.length
										? "Bounded polling; edits and deletions can have gaps."
										: "Choose conversations to watch. Nothing is imported until selected."}
					</output>
					{status.followMode !== "all_joined" && (
						<button
							type="button"
							disabled={busy || loginPending}
							onClick={() => void controller.action("slack.follow")}
						>
							Follow all my conversations
						</button>
					)}
					{status.followMode === "all_joined" && (
						<p className="small">
							New conversations are discovered automatically. Messages sync in the background as
							Slack allows.
						</p>
					)}
					<details className="small">
						<summary>Conversations and exclusions</summary>
						<button
							type="button"
							className="quiet"
							disabled={busy}
							onClick={() => void controller.load()}
						>
							{conversations.length && cursor ? "More conversations" : "Show conversations"}
						</button>
						<div className="slack-watch-options">
							{conversations.map((row) => (
								<label className="day-hint slack-watch-option" key={row.id}>
									<input
										type="checkbox"
										checked={
											status.followMode === "all_joined"
												? !excluded.includes(row.id)
												: selected.includes(row.id)
										}
										disabled={busy || !row.canRead}
										onChange={(event) => controller.select(row.id, event.currentTarget.checked)}
									/>
									{row.name} · {row.visibility.replaceAll("_", " ")}
								</label>
							))}
						</div>
						{!!conversations.length && (
							<button
								type="button"
								disabled={busy || selected.length > 1000 || excluded.length > 1000}
								onClick={() =>
									void controller.action(
										status.followMode === "all_joined" ? "slack.follow" : "slack.watch"
									)
								}
							>
								{status.followMode === "all_joined"
									? "Save exclusions"
									: "Save watched conversations"}
							</button>
						)}
					</details>
				</div>
			)}
			{status && status.phase !== "connected" && (
				<output>
					Watched conversations are unavailable. Check your Slack connection and retry.
				</output>
			)}
			<button
				type="button"
				className="quiet"
				disabled={busy}
				onClick={() => void controller.refresh()}
			>
				Refresh Slack status
			</button>
			<details className="small">
				<summary>Developer connection methods</summary>
				<p>
					Optionally import a Slack user token from the main-only .env using SLACK_USER_TOKEN and
					SLACK_APP_ID.
				</p>
				<div className="hub-actions">
					<button
						type="button"
						className="quiet"
						disabled={busy || loginPending}
						onClick={() => void controller.action("slack.openSetup")}
					>
						Open developer configuration
					</button>
					<button
						type="button"
						className="quiet"
						disabled={busy || loginPending}
						onClick={() => void controller.action("slack.connect")}
					>
						Import .env Slack user token
					</button>
				</div>
			</details>
		</section>
	);
}
