import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
	type ChatConversation,
	ChatConversationSchema,
	type SlackConnectionStatus,
	SlackConnectionStatusSchema,
} from "../../shared/contracts/chat";
import { createConversationApi } from "../conversation/api";

export function SlackConnections() {
	const api = useMemo(
		() => createConversationApi((input) => window.electron.trpc.request(input)),
		[]
	);
	const [status, setStatus] = useState<SlackConnectionStatus | null>(null);
	const [conversations, setConversations] = useState<ChatConversation[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const identity = useRef<string | undefined>(undefined);
	const dirty = useRef(false);
	const refresh = useCallback(async () => {
		try {
			const next = SlackConnectionStatusSchema.parse(await api.call("query", "slack.status", {}));
			if (next.phase !== "checking") {
				const key = next.account ? `${next.account.workspaceId}:${next.account.userId}` : "none";
				if (identity.current !== undefined && identity.current !== key) {
					setConversations([]);
					setSelected([]);
					setCursor(null);
					dirty.current = false;
					window.dispatchEvent(new Event("muse:slack-account-change"));
				}
				identity.current = key;
			}
			setStatus(next);
			if (!dirty.current) setSelected(next.watching);
		} catch {
			setError("Slack status is unavailable. Check the connection and retry.");
		}
	}, [api]);
	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 3000);
		return () => clearInterval(timer);
	}, [refresh]);
	const action = async (path: string, input: unknown = {}) => {
		setBusy(true);
		setError("");
		try {
			await api.call("mutation", path, input);
			if (path === "slack.watch") dirty.current = false;
			await refresh();
		} catch {
			setError("Slack could not confirm the change. Check setup and retry.");
		} finally {
			setBusy(false);
		}
	};
	const load = async () => {
		const account = identity.current;
		setBusy(true);
		setError("");
		try {
			const page = z
				.strictObject({
					items: z.array(ChatConversationSchema),
					nextCursor: z.string().nullable(),
					hasMore: z.boolean(),
				})
				.parse(await api.call("query", "slack.conversations", cursor ? { cursor } : {}));
			if (identity.current !== account) return;
			setConversations((previous) => [
				...new Map([...previous, ...page.items].map((row) => [row.id, row])).values(),
			]);
			setCursor(page.nextCursor);
		} catch {
			setError("Slack conversations could not be read with this connection.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="hub-setup" aria-label="Slack connection">
			<h3>Slack</h3>
			<output data-testid="slack-account-status" aria-live="polite">
				{status?.phase === "connected"
					? `Connected · ${status.account?.workspaceName} / ${status.account?.userName}`
					: status?.phase === "checking"
						? "Checking connection…"
						: status?.phase === "error"
							? "Connection needs attention"
							: "Not connected"}
			</output>
			{error && <p role="alert">{error}</p>}
			<div className="hub-actions">
				<button
					type="button"
					className="quiet"
					disabled={busy}
					onClick={() => void action("slack.openSetup")}
				>
					Configure Slack
				</button>
				<button
					type="button"
					className="quiet"
					disabled={busy || !!status?.missing.length}
					onClick={() => void action("slack.connect")}
				>
					Connect configured Slack account
				</button>
			</div>
			<details>
				<summary>Connection setup</summary>
				<p>
					Configure your Slack user connection in the local .env. Browser OAuth requires a
					registered HTTPS callback service. Existing GitHub and Linear connections stay available.
				</p>
			</details>
			{status?.phase === "connected" && (
				<>
					<p>
						{status.coverage === "socket"
							? "Live events for watched conversations"
							: status.watching.length
								? "Bounded polling for watched conversations; edits and deletions can have gaps."
								: "Choose conversations to watch. Nothing is imported until selected."}
					</p>
					<button type="button" className="quiet" disabled={busy} onClick={() => void load()}>
						{conversations.length && cursor ? "More conversations" : "Choose conversations"}
					</button>
					{conversations.map((row) => (
						<label className="day-hint" key={row.id}>
							<input
								type="checkbox"
								checked={selected.includes(row.id)}
								disabled={!row.canRead}
								onChange={(event) => {
									const checked = event.currentTarget.checked;
									dirty.current = true;
									setSelected((previous) =>
										checked ? [...previous, row.id] : previous.filter((id) => id !== row.id)
									);
								}}
							/>
							{row.name} · {row.visibility.replaceAll("_", " ")}
						</label>
					))}
					{!!conversations.length && (
						<button
							type="button"
							disabled={busy || selected.length > 32}
							onClick={() => void action("slack.watch", { conversationIds: selected })}
						>
							Save watched conversations
						</button>
					)}
				</>
			)}
		</section>
	);
}
