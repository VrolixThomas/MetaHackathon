import type {
	ChatConversation,
	ChatMessage,
	SlackConnectionStatus,
	SlackMessagePage,
} from "../../shared/contracts/chat";
import type { ConversationApi } from "../conversation/api";
import { createSlackBrowseController } from "./controller";

export const conversation = (id = "C01"): ChatConversation => ({
	workspaceId: "T01",
	id,
	name: `Controlled ${id}`,
	visibility: "public_channel",
	canRead: true,
	canReply: true,
});
export const connected = (): SlackConnectionStatus => ({
	phase: "connected",
	account: {
		workspaceId: "T01",
		userId: "U01",
		workspaceName: "Controlled workspace",
		userName: "Controlled reader",
	},
	missing: [],
	coverage: "bounded-poll",
	watching: [],
	followMode: "all_joined",
	excludedConversationIds: [],
	error: null,
});
export const message = (ts = "1000000000.000001", conversationId = "C01"): ChatMessage => ({
	citation: {
		source: {
			provider: "slack",
			workspaceId: "T01",
			conversationId,
			messageId: ts,
			threadId: null,
			revisionId: ts,
			permalink: null,
		},
		audience: {
			workspaceId: "T01",
			conversationId,
			visibility: "public_channel",
			readerIds: ["U01", "U02"],
			membershipRevision: "controlled-membership",
			observedAt: "2026-10-31T11:00:00.000Z",
		},
	},
	authorId: "U02",
	text: `Controlled message ${ts}`,
	createdAt: "2026-10-31T11:00:00.000Z",
	updatedAt: "2026-10-31T11:00:00.000Z",
	deletedAt: null,
	truncated: false,
});
export const page = (id = "C01", threadTs: string | null = null): SlackMessagePage => ({
	actor: { workspaceId: "T01", userId: "U01" },
	conversation: conversation(id),
	items: [message(threadTs ?? undefined, id)],
	authors: [{ id: "U02", name: "Controlled author" }],
	threadTs,
	nextCursor: null,
	hasMore: false,
});

export function harness(override?: ConversationApi["call"]) {
	const calls: { type: string; path: string; input: unknown }[] = [];
	const controller = createSlackBrowseController(async (type, path, input) => {
		calls.push({ type, path, input });
		if (override) {
			const result = await override(type, path, input);
			if (result !== undefined) return result;
		}
		const args = input as { conversationId?: string; threadTs?: string };
		switch (path) {
			case "slack.status":
				return connected();
			case "slack.conversations":
				return { items: [conversation()], nextCursor: null, hasMore: false };
			case "slack.conversation":
				return conversation(args.conversationId);
			case "slack.history":
				return page(args.conversationId);
			case "slack.thread":
				return page(args.conversationId, args.threadTs);
			default:
				throw new Error(`Unexpected controlled route ${path}`);
		}
	});
	return { controller, calls };
}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** React SSR reads getInitialState; expose the actually loaded controlled store as that snapshot. */
export function ssr(controller: ReturnType<typeof createSlackBrowseController>) {
	return {
		...controller,
		store: { ...controller.store, getInitialState: controller.store.getState },
	};
}
