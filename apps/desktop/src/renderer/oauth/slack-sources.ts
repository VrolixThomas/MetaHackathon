import { z } from "zod";
import { createStore } from "zustand/vanilla";
import {
	type ChatConversation,
	ChatConversationSchema,
	type SlackConnectionStatus,
	SlackConnectionStatusSchema,
} from "../../shared/contracts/chat";
import type { ConversationApi } from "../conversation/api";
import { type OAuthController, hasPendingLogin } from "./controller";

interface SlackSourcesState {
	status: SlackConnectionStatus | null;
	conversations: ChatConversation[];
	cursor: string | null;
	selected: string[];
	excluded: string[];
	busy: boolean;
	loginPending: boolean;
	error: string;
}

const PageSchema = z.strictObject({
	items: z.array(ChatConversationSchema),
	nextCursor: z.string().nullable(),
	hasMore: z.boolean(),
});

/** Source metadata never establishes consent. Every pending read belongs to one auth epoch. */
export function createSlackSourcesController(
	call: ConversationApi["call"],
	oauth: OAuthController | null,
	onAccountChange: () => void
) {
	const store = createStore<SlackSourcesState>(() => ({
		status: null,
		conversations: [],
		cursor: null,
		selected: [],
		excluded: [],
		busy: false,
		loginPending: false,
		error: "",
	}));
	let epoch = 0;
	let disposed = false;
	let dirty = false;
	let mutating = false;
	let sourceIdentity: string | undefined;
	let oauthIdentity: string | null | undefined;
	let authSignature = "";
	let reading: { promise: Promise<void> } | undefined;
	let stopAuth: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	function authorized() {
		const state = oauth?.store.getState();
		const row = state?.rows.find((item) => item.provider === "slack");
		return !!(
			row?.phase === "connected" &&
			row.source &&
			!state?.pending.slack &&
			!state?.error &&
			!state?.errors.slack &&
			!row.error
		);
	}

	function clear() {
		++epoch;
		reading = undefined;
		dirty = false;
		mutating = false;
		store.setState({
			status: null,
			conversations: [],
			selected: [],
			excluded: [],
			cursor: null,
			busy: false,
			error: "",
		});
	}

	function syncAuth() {
		const state = oauth?.store.getState();
		const loginPending = !!state && hasPendingLogin(state);
		if (store.getState().loginPending !== loginPending) store.setState({ loginPending });
		const row = state?.rows.find((item) => item.provider === "slack");
		if (!row) return;
		const next = row.account
			? `${row.source}:${row.account.workspaceId ?? ""}:${row.account.id}`
			: null;
		const settled = !state?.pending.slack && row.phase !== "connecting";
		const changed = settled && oauthIdentity !== undefined && oauthIdentity !== next;
		if (settled) oauthIdentity = next;
		const signature = JSON.stringify([
			next,
			row.phase,
			row.source,
			row.error,
			state?.pending.slack,
			state?.errors.slack,
			state?.error,
		]);
		if (signature !== authSignature) {
			authSignature = signature;
			clear();
			if (changed) {
				// OAuth already identified the change. Do not announce it again via source polling.
				sourceIdentity = undefined;
				onAccountChange();
			}
			void refresh();
		}
	}

	function refresh(): Promise<void> {
		if (disposed || mutating) return Promise.resolve();
		if (reading) return reading.promise;
		const version = epoch;
		const current = () => !disposed && version === epoch;
		const operation = { promise: Promise.resolve() };
		reading = operation;
		operation.promise = (async () => {
			try {
				const next = SlackConnectionStatusSchema.parse(await call("query", "slack.status", {}));
				if (!current()) return;
				if (next.phase === "connected" && !next.account) throw new Error("Source identity missing");
				if (next.phase === "connected" && (authorized() || !oauth)) {
					const key = next.account ? `${next.account.workspaceId}:${next.account.userId}` : "none";
					if (sourceIdentity !== undefined && sourceIdentity !== key) {
						clear();
						sourceIdentity = key;
						onAccountChange();
						// A fresh read must confirm the new source before controls become usable.
						void refresh();
						return;
					}
					sourceIdentity = key;
				}
				if (!authorized()) return;
				store.setState({
					status: next,
					error: "",
					...(!dirty ? { selected: next.watching, excluded: next.excludedConversationIds } : {}),
				});
			} catch {
				if (current())
					store.setState({
						status: null,
						error: "Slack source status is unavailable. Retry to check watched conversations.",
					});
			} finally {
				if (reading === operation) reading = undefined;
			}
		})();
		return operation.promise;
	}

	async function action(
		path: "slack.watch" | "slack.follow" | "slack.connect" | "slack.openSetup"
	) {
		if (disposed || store.getState().busy) return;
		if (oauth && hasPendingLogin(oauth.store.getState())) return;
		const state = store.getState();
		if (
			["slack.watch", "slack.follow"].includes(path) &&
			(!authorized() ||
				state.status?.phase !== "connected" ||
				state.selected.length > 1000 ||
				state.excluded.length > 1000)
		)
			return;
		const version = ++epoch;
		reading = undefined;
		mutating = true;
		store.setState({ busy: true, error: "" });
		try {
			await call(
				"mutation",
				path,
				path === "slack.watch"
					? { conversationIds: state.selected }
					: path === "slack.follow"
						? { mode: "all_joined", excludedConversationIds: state.excluded }
						: {}
			);
			if (disposed || version !== epoch) return;
			mutating = false;
			if (path === "slack.watch" || path === "slack.follow") dirty = false;
			if (path === "slack.connect") await oauth?.reload();
			await refresh();
		} catch {
			if (!disposed && version === epoch)
				store.setState({ error: "Slack could not confirm the change. Check setup and retry." });
		} finally {
			if (!disposed && version === epoch) {
				mutating = false;
				store.setState({ busy: false });
			}
		}
	}

	return {
		store,
		start() {
			if (disposed || timer) return;
			stopAuth = oauth?.store.subscribe(syncAuth);
			syncAuth();
			void refresh();
			timer = setInterval(() => void refresh(), 3000);
		},
		refresh,
		action,
		select(id: string, checked: boolean) {
			if (disposed) return;
			const state = store.getState();
			if (
				!authorized() ||
				state.busy ||
				!state.conversations.some((row) => row.id === id && row.canRead)
			)
				return;
			dirty = true;
			if (state.status?.followMode === "all_joined") {
				store.setState({
					excluded: checked
						? state.excluded.filter((item) => item !== id)
						: [...new Set([...state.excluded, id])],
				});
				return;
			}
			store.setState({
				selected: checked
					? [...new Set([...state.selected, id])]
					: state.selected.filter((item) => item !== id),
			});
		},
		async load() {
			const state = store.getState();
			if (disposed || state.busy || !authorized() || state.status?.phase !== "connected") return;
			const version = epoch;
			store.setState({ busy: true, error: "" });
			try {
				const page = PageSchema.parse(
					await call("query", "slack.conversations", state.cursor ? { cursor: state.cursor } : {})
				);
				if (disposed || version !== epoch) return;
				if (page.items.some((row) => row.workspaceId !== state.status?.account?.workspaceId))
					throw new Error("Source account mismatch");
				store.setState((previous) => ({
					conversations: [
						...new Map(
							[...previous.conversations, ...page.items].map((row) => [row.id, row])
						).values(),
					],
					cursor: page.nextCursor,
				}));
			} catch {
				if (!disposed && version === epoch)
					store.setState({ error: "Slack conversations could not be read with this connection." });
			} finally {
				if (!disposed && version === epoch) store.setState({ busy: false });
			}
		},
		dispose() {
			disposed = true;
			++epoch;
			stopAuth?.();
			clearInterval(timer);
		},
	};
}
