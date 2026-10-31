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
	const { status, conversations, cursor, selected, busy, loginPending, error } = useStore(
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
				<div aria-label="Slack watched conversations">
					<h3>Watched conversations</h3>
					<output data-testid="slack-source-status" aria-live="polite">
						{status.account?.workspaceName} / {status.account?.userName} ·{" "}
						{status.coverage === "socket"
							? "Live events for watched conversations"
							: status.coverage === "paused"
								? "Watching paused"
								: status.watching.length
									? "Bounded polling; edits and deletions can have gaps."
									: "Choose conversations to watch. Nothing is imported until selected."}
					</output>
					<button
						type="button"
						className="quiet"
						disabled={busy}
						onClick={() => void controller.load()}
					>
						{conversations.length && cursor ? "More conversations" : "Choose conversations"}
					</button>
					{conversations.map((row) => (
						<label className="day-hint" key={row.id}>
							<input
								type="checkbox"
								checked={selected.includes(row.id)}
								disabled={busy || !row.canRead}
								onChange={(event) => controller.select(row.id, event.currentTarget.checked)}
							/>
							{row.name} · {row.visibility.replaceAll("_", " ")}
						</label>
					))}
					{!!conversations.length && (
						<button
							type="button"
							disabled={busy || selected.length > 32}
							onClick={() => void controller.action("slack.watch")}
						>
							Save watched conversations
						</button>
					)}
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
				Refresh watched conversations
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
