import { createStore } from "zustand/vanilla";
import {
	type ChatConversation,
	ChatConversationSchema,
	type ChatMessage,
	type SlackConnectionStatus,
	SlackConnectionStatusSchema,
	SlackConversationPageSchema,
	SlackMessagePageSchema,
	decodeSlackViewTarget,
	encodeSlackViewTarget,
} from "../../shared/contracts/chat";
import type { ConversationApi } from "../conversation/api";

export const SLACK_LIST_ERROR = "Slack conversations could not be loaded. Refresh to retry.";
export const SLACK_MESSAGES_ERROR =
	"These messages could not be read. Refresh to check access and retry.";
const SOURCE_ERROR = "Connect Slack in Settings, then refresh your conversations.";
const SOURCE_CHANGED = "Your Slack connection changed. Refresh to read from the current account.";
const MAX_CONVERSATIONS = 1000;
const MAX_MESSAGES = 600;
const timestamp = /^\d{1,16}\.\d{6}$/;
class ReaderLimitError extends Error {}

export interface SlackBrowseState {
	status: SlackConnectionStatus | null;
	conversations: ChatConversation[];
	listLoaded: boolean;
	listLoading: boolean;
	listError: string;
	listCursor: string | null;
	listHasMore: boolean;
	target: string | null;
	loadedTarget: string | null;
	conversation: ChatConversation | null;
	messages: ChatMessage[];
	authors: Record<string, string>;
	messageLoading: boolean;
	olderLoading: boolean;
	messageError: string;
	messageCursor: string | null;
	messageHasMore: boolean;
}

const initialState = (): SlackBrowseState => ({
	status: null,
	conversations: [],
	listLoaded: false,
	listLoading: false,
	listError: "",
	listCursor: null,
	listHasMore: false,
	target: null,
	loadedTarget: null,
	conversation: null,
	messages: [],
	authors: {},
	messageLoading: false,
	olderLoading: false,
	messageError: "",
	messageCursor: null,
	messageHasMore: false,
});

interface ReadOperation {
	epoch: number;
	abort: AbortController;
	promise: Promise<void>;
}

/** No history timers or background fanout: each message read belongs to an explicit target. */
export function createSlackBrowseController(call: ConversationApi["call"]) {
	const store = createStore<SlackBrowseState>(initialState);
	let epoch = 0;
	let disposed = false;
	let started = false;
	let actor: string | undefined;
	let listing: ReadOperation | undefined;
	let reading: ReadOperation | undefined;
	let listCursors = new Set<string>();
	let messageCursors = new Set<string>();

	function reset(status: SlackConnectionStatus | null = null) {
		++epoch;
		listing?.abort.abort();
		reading?.abort.abort();
		listing = undefined;
		reading = undefined;
		started = false;
		actor = status?.account ? `${status.account.workspaceId}/${status.account.userId}` : undefined;
		listCursors = new Set();
		messageCursors = new Set();
		store.setState({ ...initialState(), status });
	}

	function current(operation: ReadOperation) {
		return !disposed && operation.epoch === epoch && !operation.abort.signal.aborted;
	}
	function assertCurrent(operation: ReadOperation) {
		if (!current(operation)) throw new Error("Slack read retired");
	}

	async function query(operation: ReadOperation, path: string, input: unknown) {
		assertCurrent(operation);
		const signal = operation.abort.signal;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			return await Promise.race([
				Promise.resolve().then(() => {
					assertCurrent(operation);
					return call("query", path, input);
				}),
				new Promise<never>((_, reject) => {
					onAbort = () => reject(new Error("Slack read retired"));
					signal.addEventListener("abort", onAbort, { once: true });
					timer = setTimeout(() => reject(new Error("Slack read timed out")), 20000);
				}),
			]);
		} finally {
			clearTimeout(timer);
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	async function statusFor(operation: ReadOperation) {
		let status: SlackConnectionStatus;
		try {
			status = SlackConnectionStatusSchema.parse(await query(operation, "slack.status", {}));
		} catch (error) {
			if (current(operation)) {
				reset();
				store.setState({ listError: SOURCE_CHANGED, messageError: SOURCE_CHANGED });
			}
			throw error;
		}
		assertCurrent(operation);
		if (status.phase !== "connected" || !status.account) {
			reset(status);
			store.setState({ listError: SOURCE_ERROR, messageError: SOURCE_ERROR });
			throw new Error("Slack is not connected");
		}
		const key = `${status.account.workspaceId}/${status.account.userId}`;
		if (actor !== undefined && actor !== key) {
			reset(status);
			store.setState({ listError: SOURCE_CHANGED, messageError: SOURCE_CHANGED });
			throw new Error("Slack account changed");
		}
		actor = key;
		store.setState({ status });
		return status.account;
	}

	function validateCursor(next: string | null, hasMore: boolean, seen: Set<string>) {
		if (hasMore && (!next || seen.has(next))) throw new Error("Slack cursor did not advance");
	}

	function readConversations(append: boolean): Promise<void> {
		if (disposed) return Promise.resolve();
		if (listing) return listing.promise;
		const state = store.getState();
		if (append && (!state.listHasMore || !state.listCursor)) return Promise.resolve();
		const cursor = append ? state.listCursor : null;
		if (!append) listCursors = new Set();
		const operation: ReadOperation = {
			epoch,
			abort: new AbortController(),
			promise: Promise.resolve(),
		};
		listing = operation;
		store.setState({ listLoading: true, listError: "" });
		operation.promise = (async () => {
			try {
				const account = await statusFor(operation);
				const page = SlackConversationPageSchema.parse(
					await query(operation, "slack.conversations", cursor ? { cursor } : {})
				);
				await statusFor(operation);
				assertCurrent(operation);
				if (page.items.some((row) => row.workspaceId !== account.workspaceId))
					throw new Error("Slack catalog workspace mismatch");
				for (const row of page.items)
					encodeSlackViewTarget({ conversationId: row.id, threadTs: null });
				validateCursor(page.nextCursor, page.hasMore, listCursors);
				if (cursor && page.hasMore && page.nextCursor === cursor)
					throw new Error("Slack cursor repeated");
				const conversations = [
					...new Map(
						[...(append ? state.conversations : []), ...page.items].map((row) => [row.id, row])
					).values(),
				];
				if (conversations.length > MAX_CONVERSATIONS)
					throw new ReaderLimitError(
						"This reader holds up to 1,000 conversations. Refresh to load the catalog again."
					);
				if (cursor) listCursors.add(cursor);
				store.setState({
					conversations,
					listLoaded: true,
					listCursor: page.nextCursor,
					listHasMore: page.hasMore,
				});
			} catch (error) {
				if (current(operation))
					store.setState(
						error instanceof ReaderLimitError
							? { listError: error.message, listHasMore: false }
							: { listError: SLACK_LIST_ERROR }
					);
			} finally {
				if (listing === operation) {
					listing = undefined;
					store.setState({ listLoading: false });
				}
			}
		})();
		return operation.promise;
	}

	function loadTarget(encodedId: string, append = false, force = false): Promise<void> {
		if (disposed) return Promise.reject(new Error("Slack reader disposed"));
		let target: ReturnType<typeof decodeSlackViewTarget>;
		try {
			target = decodeSlackViewTarget(encodedId);
			if (encodeSlackViewTarget(target) !== encodedId) throw new Error("Noncanonical Slack target");
		} catch {
			reading?.abort.abort();
			reading = undefined;
			store.setState({
				target: encodedId,
				loadedTarget: null,
				conversation: null,
				messages: [],
				authors: {},
				messageLoading: false,
				olderLoading: false,
				messageError:
					"This Slack conversation target is invalid. Choose a conversation in the sidebar.",
			});
			return Promise.reject(new Error("Invalid Slack target"));
		}
		const previous = store.getState();
		if (reading && previous.target === encodedId && !force) return reading.promise;
		if (!force && !append && previous.loadedTarget === encodedId) return Promise.resolve();
		if (
			append &&
			(previous.loadedTarget !== encodedId || !previous.messageHasMore || !previous.messageCursor)
		)
			return Promise.resolve();
		reading?.abort.abort();
		const cursor = append ? previous.messageCursor : null;
		if (!append) messageCursors = new Set();
		const operation: ReadOperation = {
			epoch,
			abort: new AbortController(),
			promise: Promise.resolve(),
		};
		reading = operation;
		store.setState({
			target: encodedId,
			messageError: "",
			messageLoading: !append,
			olderLoading: append,
			...(!append
				? {
						loadedTarget: null,
						conversation: null,
						messages: [],
						authors: {},
						messageCursor: null,
						messageHasMore: false,
					}
				: {}),
		});
		operation.promise = (async () => {
			try {
				const account = await statusFor(operation);
				const conversation = ChatConversationSchema.parse(
					await query(operation, "slack.conversation", { conversationId: target.conversationId })
				);
				assertCurrent(operation);
				if (
					conversation.workspaceId !== account.workspaceId ||
					conversation.id !== target.conversationId ||
					!conversation.canRead
				)
					throw new Error("Slack conversation is not readable");
				const page = SlackMessagePageSchema.parse(
					await query(operation, target.threadTs ? "slack.thread" : "slack.history", {
						conversationId: target.conversationId,
						...(target.threadTs ? { threadTs: target.threadTs } : {}),
						...(cursor ? { cursor } : {}),
					})
				);
				await statusFor(operation);
				assertCurrent(operation);
				if (
					page.actor.workspaceId !== account.workspaceId ||
					page.actor.userId !== account.userId ||
					page.conversation.id !== target.conversationId ||
					!page.conversation.canRead ||
					page.threadTs !== target.threadTs ||
					page.conversation.visibility !== conversation.visibility ||
					page.items.some(
						(row) =>
							!timestamp.test(row.citation.source.messageId) ||
							row.citation.audience.visibility !== conversation.visibility ||
							(row.citation.source.threadId !== null &&
								!timestamp.test(row.citation.source.threadId))
					)
				)
					throw new Error("Slack source identity mismatch");
				validateCursor(page.nextCursor, page.hasMore, messageCursors);
				if (cursor && page.hasMore && page.nextCursor === cursor)
					throw new Error("Slack cursor repeated");
				const messages = mergeMessages(append ? previous.messages : [], page.items);
				if (messages.length > MAX_MESSAGES)
					throw new ReaderLimitError(
						"This reader holds up to 600 messages. Refresh to return to the latest messages."
					);
				if (cursor) messageCursors.add(cursor);
				const authors = Object.fromEntries([
					...Object.entries(append ? previous.authors : {}),
					...page.authors.map((author) => [author.id, author.name]),
				]);
				store.setState({
					loadedTarget: encodedId,
					conversation: page.conversation,
					messages,
					authors,
					messageCursor: page.nextCursor,
					messageHasMore: page.hasMore,
				});
			} catch (error) {
				if (current(operation) && append && error instanceof ReaderLimitError) {
					store.setState({ messageError: error.message, messageHasMore: false });
					return;
				}
				if (current(operation))
					store.setState({
						loadedTarget: null,
						conversation: null,
						messages: [],
						authors: {},
						messageError: SLACK_MESSAGES_ERROR,
					});
				throw error;
			} finally {
				if (reading === operation) {
					reading = undefined;
					store.setState({ messageLoading: false, olderLoading: false });
				}
			}
		})();
		return operation.promise;
	}

	return {
		store,
		async start() {
			if (disposed || started) return;
			started = true;
			await readConversations(false);
		},
		reset: () => reset(),
		ensureTarget: (encodedId: string) => loadTarget(encodedId),
		refreshConversations: () => readConversations(false),
		loadMoreConversations: () => readConversations(true),
		async refreshCurrent() {
			if (reading) {
				await reading.promise.catch(() => {});
				return;
			}
			const target = store.getState().target;
			if (target) await loadTarget(target, false, true).catch(() => {});
		},
		async loadOlder() {
			const target = store.getState().loadedTarget;
			if (target) await loadTarget(target, true).catch(() => {});
		},
		dispose() {
			disposed = true;
			reset();
		},
	};
}

/** Keep the freshest observed revision, including deletion, when older pages overlap. */
function mergeMessages(previous: ChatMessage[], incoming: ChatMessage[]) {
	const rows = new Map(previous.map((row) => [row.citation.source.messageId, row]));
	for (const row of incoming) {
		const key = row.citation.source.messageId;
		const existing = rows.get(key);
		if (existing?.deletedAt && !row.deletedAt) continue;
		if (
			!existing ||
			row.updatedAt > existing.updatedAt ||
			(row.updatedAt === existing.updatedAt && (!existing.deletedAt || row.deletedAt))
		)
			rows.set(key, row);
	}
	return [...rows.values()].sort((a, b) => {
		const aTs = BigInt(a.citation.source.messageId.replace(".", ""));
		const bTs = BigInt(b.citation.source.messageId.replace(".", ""));
		return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
	});
}

export type SlackBrowseController = ReturnType<typeof createSlackBrowseController>;
