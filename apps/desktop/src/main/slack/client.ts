import { createHash } from "node:crypto";
import { z } from "zod";
import {
	type ChatConversation,
	ChatConversationSchema,
	type ChatMessage,
	ChatMessageSchema,
	type ChatReplyReceipt,
	ChatReplyReceiptSchema,
	type ChatSource,
	ChatSourceSchema,
	type SourceAudience,
	SourceAudienceSchema,
} from "../../shared/contracts/chat";
import { SlackProfileLabels } from "./profile-labels";
import { SlackTransport } from "./transport";
import {
	type SlackCredential,
	SlackCredentialSchema,
	SlackError,
	SlackIdSchema,
	SlackTsSchema,
	abortable,
	parsed,
} from "./types";

const CursorSchema = z.string().max(2000);
const PagingSchema = z.strictObject({
	cursor: CursorSchema.optional(),
	limit: z.int().min(1).max(15).optional(),
});
const ReadSchema = PagingSchema.extend({
	conversationId: SlackIdSchema,
	oldest: SlackTsSchema.optional(),
	latest: SlackTsSchema.optional(),
	inclusive: z.boolean().optional(),
});
const ThreadSchema = ReadSchema.extend({ threadTs: SlackTsSchema });
const MetadataSchema = z.object({ next_cursor: CursorSchema.optional() }).optional();
const ChannelSchema = z.object({
	id: SlackIdSchema,
	context_team_id: SlackIdSchema.optional(),
	name: z.string().max(300).optional(),
	user: SlackIdSchema.optional(),
	members: z.unknown().optional(),
	is_im: z.boolean().optional(),
	is_mpim: z.boolean().optional(),
	is_private: z.boolean().optional(),
	is_channel: z.boolean().optional(),
	is_group: z.boolean().optional(),
	is_archived: z.boolean().optional(),
	is_member: z.boolean().optional(),
});
export const RawSlackMessageSchema = z.object({
	ts: SlackTsSchema,
	text: z.string().max(40000).optional(),
	user: SlackIdSchema.optional(),
	bot_id: SlackIdSchema.optional(),
	thread_ts: SlackTsSchema.optional(),
	edited: z.object({ ts: SlackTsSchema }).optional(),
	subtype: z.string().max(100).optional(),
	hidden: z.boolean().optional(),
	reply_count: z.int().nonnegative().optional(),
});
export type RawSlackMessage = z.infer<typeof RawSlackMessageSchema>;
export type SlackReadInput = z.infer<typeof ReadSchema>;
export type SlackThreadInput = z.infer<typeof ThreadSchema>;
export interface SlackPage<T> {
	items: T[];
	nextCursor: string | null;
	hasMore: boolean;
}
export interface SlackMessagePage extends SlackPage<ChatMessage> {
	threadIds: string[];
}

export interface SlackReplyRequest {
	requestId: string;
	source: ChatSource;
	body: string;
}
/** Atomic durable reserve precedes the send. Existing pending/uncertain records must not reserve again. */
export interface SlackReplyLedger {
	authorize?(key: string, bindingDigest: string): Promise<void>;
	reserve(
		key: string,
		bindingDigest: string
	): Promise<
		| { state: "reserved" }
		| { state: "uncertain" }
		| { state: "delivered"; receipt: ChatReplyReceipt }
	>;
	delivered(key: string, bindingDigest: string, receipt: ChatReplyReceipt): Promise<void>;
}
export interface SlackClientOptions {
	getCredential(): Promise<SlackCredential | undefined>;
	fetch?: typeof fetch;
	now?: () => number;
	historyIntervalMs?: number;
	replyLedger?: SlackReplyLedger;
}
const visibilityScopes = {
	public_channel: ["channels:read", "channels:history"],
	private_channel: ["groups:read", "groups:history"],
	direct_message: ["im:read", "im:history"],
	group_direct_message: ["mpim:read", "mpim:history"],
} as const;
export function slackDate(ts: string): string {
	parsed(SlackTsSchema, ts);
	const [seconds = "", fraction = ""] = ts.split(".");
	const date = new Date(Number(seconds) * 1000 + Number(fraction.slice(0, 3)));
	if (!Number.isFinite(date.getTime())) throw new SlackError("invalid-data");
	return date.toISOString();
}
export function slackDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function visibility(row: z.infer<typeof ChannelSchema>): SourceAudience["visibility"] {
	if (row.is_im) return "direct_message";
	if (row.is_mpim) return "group_direct_message";
	if (row.is_private || row.is_group) return "private_channel";
	if (row.is_channel && row.is_private === false) return "public_channel";
	throw new SlackError("invalid-data");
}
function describeConversation(
	credential: SlackCredential,
	row: z.infer<typeof ChannelSchema>,
	name?: string
): ChatConversation {
	const kind = visibility(row);
	return parsed(ChatConversationSchema, {
		workspaceId: credential.workspaceId,
		id: row.id,
		name: name || row.name || row.user || row.id,
		visibility: kind,
		canRead: visibilityScopes[kind].every((scope) => credential.scopes.includes(scope)),
		canReply: !row.is_archived && credential.scopes.includes("chat:write"),
	});
}
function operationSignal(signal?: AbortSignal): AbortSignal {
	return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
}
export function slackMessage(raw: RawSlackMessage, audience: SourceAudience): ChatMessage {
	const authorId = raw.user ?? raw.bot_id;
	if (!authorId) throw new SlackError("invalid-data");
	return parsed(ChatMessageSchema, {
		citation: {
			audience,
			source: {
				provider: "slack",
				workspaceId: audience.workspaceId,
				conversationId: audience.conversationId,
				messageId: raw.ts,
				threadId: raw.thread_ts && raw.thread_ts !== raw.ts ? raw.thread_ts : null,
				revisionId: raw.edited?.ts ?? raw.ts,
				permalink: null,
			},
		},
		authorId,
		text: raw.text ?? "",
		createdAt: slackDate(raw.ts),
		updatedAt: slackDate(raw.edited?.ts ?? raw.ts),
		deletedAt: null,
		truncated: false,
	});
}

/** No env/OS/renderer dependencies. Every operation uses the root-owned current user credential. */
export class SlackClient {
	readonly transport: SlackTransport;
	private readonly now: () => number;
	private readonly profileLabels: SlackProfileLabels;
	private readonly observedThreads = new WeakMap<
		SlackMessagePage,
		{ credential: SlackCredential; at: number; digest: string }
	>();
	private readonly sends = new Map<
		string,
		{ binding: string; promise: Promise<ChatReplyReceipt> }
	>();
	constructor(private readonly options: SlackClientOptions) {
		this.transport = new SlackTransport(options);
		this.now = options.now ?? Date.now;
		this.profileLabels = new SlackProfileLabels({
			now: this.now,
			assertCurrent: (credential, signal) => this.assertCurrent(credential, signal),
			request: (credential, method, fields, signal) =>
				this.call(credential, method, fields, signal),
		});
	}
	async credential(signal?: AbortSignal): Promise<SlackCredential> {
		try {
			const value = await abortable(this.options.getCredential(), operationSignal(signal));
			if (!value) throw new SlackError("connection-required");
			return parsed(SlackCredentialSchema, value);
		} catch (error) {
			throw error instanceof SlackError ? error : new SlackError("connection-required");
		}
	}
	async assertCurrent(credential: SlackCredential, signal?: AbortSignal): Promise<void> {
		const current = await this.credential(signal);
		if (
			current.connectionId !== credential.connectionId ||
			current.workspaceId !== credential.workspaceId ||
			current.userId !== credential.userId ||
			current.appId !== credential.appId
		)
			throw new SlackError("stale-connection");
	}
	private async call(
		credential: SlackCredential,
		method: Parameters<SlackTransport["call"]>[0],
		fields: Record<string, string | number | boolean>,
		parentSignal?: AbortSignal,
		beforeRequest?: () => Promise<void>
	): Promise<unknown> {
		const signal = operationSignal(parentSignal);
		if (signal?.aborted) throw new SlackError("cancelled");
		await this.assertCurrent(credential, signal);
		await beforeRequest?.();
		const result = await this.transport.call(method, {
			token: credential.accessToken,
			fields,
			signal,
			bucket: `${credential.appId}:${credential.workspaceId}`,
		});
		await this.assertCurrent(credential, signal);
		if (signal?.aborted) throw new SlackError("cancelled");
		return result;
	}
	async capabilities(parentSignal?: AbortSignal) {
		const signal = operationSignal(parentSignal);
		const credential = await this.credential(signal);
		const identity = parsed(
			z.object({
				team_id: SlackIdSchema,
				user_id: SlackIdSchema,
				bot_id: SlackIdSchema.optional(),
			}),
			await this.call(credential, "auth.test", {}, signal)
		);
		if (
			identity.bot_id ||
			identity.team_id !== credential.workspaceId ||
			identity.user_id !== credential.userId
		)
			throw new SlackError("access-denied");
		return {
			workspaceId: credential.workspaceId,
			userId: credential.userId,
			tokenKind: "user" as const,
			scopes: [...credential.scopes],
			discovery: "user-memberships" as const,
			visibility: Object.entries(visibilityScopes).map(([kind, scopes]) => ({
				kind,
				canRead: scopes.every((scope) => credential.scopes.includes(scope)),
				membershipRequired: kind !== "public_channel",
			})),
			canReply: credential.scopes.includes("chat:write"),
			polling: {
				edits: "bounded-rescan-only" as const,
				deletes: "not-observable" as const,
				threads: "explicit-or-discovered-only" as const,
			},
		};
	}
	async listConversations(
		input: z.infer<typeof PagingSchema> = {},
		parentSignal?: AbortSignal,
		resolveLabels = true
	): Promise<SlackPage<ChatConversation>> {
		const signal = operationSignal(parentSignal);
		const paging = parsed(PagingSchema, input);
		parsed(z.boolean(), resolveLabels);
		const credential = await this.credential(signal);
		const types = Object.entries(visibilityScopes)
			.filter(([, scopes]) => credential.scopes.includes(scopes[0]))
			.map(
				([kind]) =>
					({
						public_channel: "public_channel",
						private_channel: "private_channel",
						direct_message: "im",
						group_direct_message: "mpim",
					})[kind]
			);
		if (!types.length) throw new SlackError("missing-scope");
		const value = parsed(
			z.object({ channels: z.array(ChannelSchema).max(15), response_metadata: MetadataSchema }),
			await this.call(
				credential,
				"users.conversations",
				{
					types: types.join(","),
					limit: paging.limit ?? 15,
					exclude_archived: true,
					...(paging.cursor ? { cursor: paging.cursor } : {}),
				},
				signal
			)
		);
		const channels = value.channels.filter((row) => !row.is_archived && row.is_member !== false);
		const names = resolveLabels ? await this.profileLabels.names(credential, channels, signal) : [];
		await this.assertCurrent(credential, signal);
		const items = channels.map((row, index) => describeConversation(credential, row, names[index]));
		const nextCursor = value.response_metadata?.next_cursor || null;
		return { items, nextCursor, hasMore: !!nextCursor };
	}
	/** Main-only metadata for an authorized conversation; actual source access still requires fresh audience reads. */
	async conversation(
		conversationId: string,
		parentSignal?: AbortSignal
	): Promise<ChatConversation> {
		parsed(SlackIdSchema, conversationId);
		const signal = operationSignal(parentSignal);
		const credential = await this.credential(signal);
		const { channel, audience } = await this.authorizedConversation(
			conversationId,
			signal,
			credential
		);
		if (!audience.readerIds.includes(credential.userId)) throw new SlackError("access-denied");
		if (
			audience.workspaceId !== credential.workspaceId ||
			audience.conversationId !== conversationId ||
			(channel.context_team_id && channel.context_team_id !== credential.workspaceId) ||
			// Slackbot is a system peer: Slack omits it from conversations.members.
			// The connected human must still pass the fresh membership check above.
			(channel.is_im &&
				channel.user &&
				channel.user !== "USLACKBOT" &&
				!audience.readerIds.includes(channel.user))
		)
			throw new SlackError("invalid-data");
		const [name] = await this.profileLabels.names(
			credential,
			[channel.is_mpim ? { ...channel, members: audience.readerIds } : channel],
			signal
		);
		await this.assertCurrent(credential, signal);
		return describeConversation(credential, channel, name);
	}
	/** Main-only presentation hints for at most 15 observed message authors; not a source-read grant. */
	async authorLabels(
		authorIds: string[],
		parentSignal?: AbortSignal
	): Promise<{ id: string; name: string }[]> {
		const ids = parsed(z.array(SlackIdSchema).max(15), authorIds);
		const signal = operationSignal(parentSignal);
		const credential = await this.credential(signal);
		const labels = await this.profileLabels.authors(credential, ids, signal);
		await this.assertCurrent(credential, signal);
		return labels;
	}
	/** Fresh metadata + full bounded membership; a partial audience never becomes an access grant. */
	async audience(
		conversationId: string,
		parentSignal?: AbortSignal,
		expected?: SlackCredential
	): Promise<SourceAudience> {
		return (await this.authorizedConversation(conversationId, parentSignal, expected)).audience;
	}
	private async authorizedConversation(
		conversationId: string,
		parentSignal?: AbortSignal,
		expected?: SlackCredential
	): Promise<{ channel: z.infer<typeof ChannelSchema>; audience: SourceAudience }> {
		const signal = operationSignal(parentSignal);
		parsed(SlackIdSchema, conversationId);
		const credential = expected ?? (await this.credential(signal));
		const value = parsed(
			z.object({ channel: ChannelSchema }),
			await this.call(credential, "conversations.info", { channel: conversationId }, signal)
		);
		if (value.channel.id !== conversationId) throw new SlackError("invalid-data");
		const kind = visibility(value.channel);
		if (!visibilityScopes[kind].every((scope) => credential.scopes.includes(scope)))
			throw new SlackError("missing-scope");
		let cursor: string | undefined;
		const seen = new Set<string>();
		const members = new Set<string>();
		for (let page = 0; page < 50; page++) {
			const response = parsed(
				z.object({ members: z.array(SlackIdSchema).max(200), response_metadata: MetadataSchema }),
				await this.call(
					credential,
					"conversations.members",
					{ channel: conversationId, limit: 200, ...(cursor ? { cursor } : {}) },
					signal
				)
			);
			for (const id of response.members) members.add(id);
			cursor = response.response_metadata?.next_cursor || undefined;
			if (!cursor) break;
			if (seen.has(cursor) || page === 49) throw new SlackError("capacity");
			seen.add(cursor);
		}
		if (kind !== "public_channel" && !members.has(credential.userId))
			throw new SlackError("access-denied");
		const readerIds = [...members].sort();
		const audience = parsed(SourceAudienceSchema, {
			workspaceId: credential.workspaceId,
			conversationId,
			visibility: kind,
			readerIds,
			membershipRevision: slackDigest(JSON.stringify([kind, readerIds])),
			observedAt: new Date(this.now()).toISOString(),
		});
		return { channel: value.channel, audience };
	}
	async history(input: SlackReadInput, signal?: AbortSignal): Promise<SlackMessagePage> {
		return this.read(parsed(ReadSchema, input), signal);
	}
	async thread(input: SlackThreadInput, signal?: AbortSignal): Promise<SlackMessagePage> {
		return this.read(parsed(ThreadSchema, input), signal);
	}
	/** Re-read exact source text/revision with current membership for day/knowledge authorization. */
	async sourceMessage(source: ChatSource, parentSignal?: AbortSignal): Promise<ChatMessage> {
		const signal = operationSignal(parentSignal);
		parsed(ChatSourceSchema, source);
		parsed(SlackTsSchema, source.messageId);
		const credential = await this.credential(signal);
		if (source.workspaceId !== credential.workspaceId) throw new SlackError("access-denied");
		const input = {
			conversationId: source.conversationId,
			oldest: source.messageId,
			latest: source.messageId,
			limit: 1,
		};
		const page = source.threadId
			? await this.thread({ ...input, threadTs: source.threadId }, signal)
			: await this.history(input, signal);
		const message = page.items.find((row) => row.citation.source.messageId === source.messageId);
		if (!message) throw new SlackError("access-denied");
		if (
			message.citation.source.revisionId !== source.revisionId ||
			message.citation.source.threadId !== source.threadId
		)
			throw new SlackError("stale-source");
		return message;
	}
	private async read(
		input: SlackReadInput & { threadTs?: string },
		parentSignal?: AbortSignal
	): Promise<SlackMessagePage> {
		const signal = operationSignal(parentSignal);
		const credential = await this.credential(signal);
		const audience = await this.audience(input.conversationId, signal, credential);
		const value = parsed(
			z.object({
				messages: z.array(RawSlackMessageSchema).max(15),
				response_metadata: MetadataSchema,
				has_more: z.boolean().optional(),
			}),
			await this.call(
				credential,
				input.threadTs ? "conversations.replies" : "conversations.history",
				{
					channel: input.conversationId,
					limit: input.limit ?? 15,
					...(input.threadTs ? { ts: input.threadTs } : {}),
					...(input.cursor ? { cursor: input.cursor } : {}),
					...(input.oldest ? { oldest: input.oldest, inclusive: input.inclusive ?? true } : {}),
					...(input.latest ? { latest: input.latest, inclusive: input.inclusive ?? true } : {}),
				},
				signal
			)
		);
		const items = value.messages
			.filter((row) => !row.hidden)
			.map((row) => {
				if (input.threadTs && row.ts !== input.threadTs && row.thread_ts !== input.threadTs)
					throw new SlackError("invalid-data");
				return slackMessage(row, audience);
			});
		const nextCursor = value.response_metadata?.next_cursor || null;
		const page = {
			items,
			nextCursor,
			hasMore: !!nextCursor || !!value.has_more,
			threadIds: [
				...new Set(
					value.messages
						.filter((row) => (row.reply_count ?? 0) > 0)
						.map((row) => row.thread_ts ?? row.ts)
				),
			],
		};
		if (input.threadTs)
			this.observedThreads.set(page, {
				credential,
				at: this.now(),
				digest: slackDigest(JSON.stringify(page)),
			});
		return page;
	}
	/** Main-only, single-use actual complete thread observation, never a serialized audience snapshot. */
	async sendFromObservedThread(
		input: SlackReplyRequest,
		page: SlackMessagePage,
		signal?: AbortSignal
	): Promise<ChatReplyReceipt> {
		const observed = this.observedThreads.get(page);
		this.observedThreads.delete(page);
		if (
			!observed ||
			this.now() - observed.at > 10000 ||
			page.hasMore ||
			page.nextCursor ||
			observed.digest !== slackDigest(JSON.stringify(page))
		)
			throw new SlackError("stale-source");
		const original = page.items.find((m) => m.citation.source.messageId === input.source.messageId);
		if (
			!original ||
			original.deletedAt ||
			original.truncated ||
			JSON.stringify(original.citation.source) !== JSON.stringify(input.source)
		)
			throw new SlackError("stale-source");
		parsed(ChatSourceSchema, input.source);
		parsed(z.string().min(1).max(200), input.requestId);
		parsed(z.string().min(1).max(4000), input.body);
		return this.sendOnce(
			input,
			slackDigest(JSON.stringify([input.source, input.body])),
			signal,
			async (credential) => {
				await this.assertCurrent(observed.credential, signal);
				if (credential.connectionId !== observed.credential.connectionId)
					throw new SlackError("stale-connection");
				const audience = await this.audience(input.source.conversationId, signal, credential);
				if (!audience.readerIds.includes(credential.userId)) throw new SlackError("access-denied");
			},
			() => {
				if (this.now() - observed.at > 10000) throw new SlackError("stale-source");
			}
		);
	}
	send(input: SlackReplyRequest, signal?: AbortSignal): Promise<ChatReplyReceipt> {
		const source = parsed(ChatSourceSchema, input.source);
		const requestId = parsed(z.string().min(1).max(200), input.requestId);
		const body = parsed(z.string().min(1).max(4000), input.body);
		parsed(SlackTsSchema, source.messageId);
		if (source.threadId) parsed(SlackTsSchema, source.threadId);
		const binding = slackDigest(JSON.stringify([source, body]));
		const existing = this.sends.get(requestId);
		if (existing) {
			if (binding !== existing.binding) return Promise.reject(new SlackError("request-conflict"));
			return existing.promise;
		}
		if (this.sends.size >= 64) return Promise.reject(new SlackError("capacity"));
		const promise = this.sendOnce({ requestId, source, body }, binding, signal).finally(() =>
			this.sends.delete(requestId)
		);
		this.sends.set(requestId, { binding, promise });
		return promise;
	}
	private async sendOnce(
		input: SlackReplyRequest,
		binding: string,
		parentSignal?: AbortSignal,
		verifySource?: (credential: SlackCredential) => Promise<void>,
		verifyFresh?: () => void
	): Promise<ChatReplyReceipt> {
		const signal = operationSignal(parentSignal);
		const credential = await this.credential(signal);
		if (input.source.workspaceId !== credential.workspaceId) throw new SlackError("access-denied");
		if (!credential.scopes.includes("chat:write")) throw new SlackError("missing-scope");
		if (!this.options.replyLedger) throw new SlackError("capacity");
		if (verifySource) await verifySource(credential);
		else await this.sourceMessage(input.source, signal);
		const key = `${credential.connectionId}:${input.requestId}`;
		let reservation: Awaited<ReturnType<SlackReplyLedger["reserve"]>>;
		try {
			reservation = await abortable(this.options.replyLedger.reserve(key, binding), signal);
		} catch (error) {
			throw error instanceof SlackError ? error : new SlackError("provider");
		}
		if (reservation.state === "delivered") {
			const receipt = parsed(ChatReplyReceiptSchema, reservation.receipt);
			if (
				receipt.requestId !== input.requestId ||
				receipt.bodyDigest !== slackDigest(input.body) ||
				receipt.source.workspaceId !== input.source.workspaceId ||
				receipt.source.conversationId !== input.source.conversationId ||
				receipt.source.threadId !== (input.source.threadId ?? input.source.messageId)
			)
				throw new SlackError("request-conflict");
			return receipt;
		}
		if (reservation.state === "uncertain") throw new SlackError("uncertain-delivery");
		let result: unknown;
		try {
			result = await this.call(
				credential,
				"chat.postMessage",
				{
					channel: input.source.conversationId,
					thread_ts: input.source.threadId ?? input.source.messageId,
					text: input.body,
					unfurl_links: false,
					unfurl_media: false,
					reply_broadcast: false,
					parse: "none",
				},
				signal,
				async () => {
					verifyFresh?.();
					await this.options.replyLedger?.authorize?.(key, binding);
					verifyFresh?.();
				}
			);
		} catch {
			throw new SlackError("uncertain-delivery");
		}
		const value = z
			.object({
				channel: SlackIdSchema,
				ts: SlackTsSchema,
				message: z.object({
					text: z.string().max(40000),
					thread_ts: SlackTsSchema,
					user: SlackIdSchema.optional(),
				}),
			})
			.safeParse(result);
		if (
			!value.success ||
			value.data.channel !== input.source.conversationId ||
			value.data.message.thread_ts !== (input.source.threadId ?? input.source.messageId) ||
			value.data.message.text !== input.body ||
			(value.data.message.user && value.data.message.user !== credential.userId)
		)
			throw new SlackError("uncertain-delivery");
		const receipt = parsed(ChatReplyReceiptSchema, {
			requestId: input.requestId,
			source: {
				provider: "slack",
				workspaceId: credential.workspaceId,
				conversationId: value.data.channel,
				messageId: value.data.ts,
				threadId: input.source.threadId ?? input.source.messageId,
				revisionId: value.data.ts,
				permalink: null,
			},
			bodyDigest: slackDigest(input.body),
			deliveredAt: new Date(this.now()).toISOString(),
		});
		try {
			await abortable(this.options.replyLedger.delivered(key, binding, receipt), signal);
		} catch {
			throw new SlackError("uncertain-delivery");
		}
		return receipt;
	}
}
