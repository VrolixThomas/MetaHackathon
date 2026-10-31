import { z } from "zod";
import { DateTimeSchema, IdSchema } from "./common";

export const ChatVisibilitySchema = z.enum([
	"public_channel",
	"private_channel",
	"direct_message",
	"group_direct_message",
]);
export const ChatSourceSchema = z.strictObject({
	provider: z.literal("slack"),
	workspaceId: IdSchema,
	conversationId: IdSchema,
	messageId: IdSchema,
	threadId: IdSchema.nullable(),
	revisionId: IdSchema,
	permalink: z.url().max(2048).nullable(),
});
/** A stored audience is evidence of capture, never authority to bypass a fresh access check. */
export const SourceAudienceSchema = z.strictObject({
	workspaceId: IdSchema,
	conversationId: IdSchema,
	visibility: ChatVisibilitySchema,
	readerIds: z.array(IdSchema).max(10000),
	membershipRevision: IdSchema,
	observedAt: DateTimeSchema,
});
export const ChatCitationSchema = z
	.strictObject({
		source: ChatSourceSchema,
		audience: SourceAudienceSchema,
	})
	.refine(
		({ source, audience }) =>
			source.workspaceId === audience.workspaceId &&
			source.conversationId === audience.conversationId,
		"Source and audience must identify the same conversation"
	);
export const ChatMessageSchema = z
	.strictObject({
		citation: ChatCitationSchema,
		authorId: IdSchema,
		text: z.string().max(40000),
		createdAt: DateTimeSchema,
		updatedAt: DateTimeSchema,
		deletedAt: DateTimeSchema.nullable(),
		truncated: z.boolean(),
	})
	.refine(
		(row) => !row.deletedAt || row.text === "",
		"Deleted messages cannot retain readable text"
	);
export const ChatConversationSchema = z.strictObject({
	workspaceId: IdSchema,
	id: IdSchema,
	name: z.string().min(1).max(300),
	visibility: ChatVisibilitySchema,
	canRead: z.boolean(),
	canReply: z.boolean(),
});
export const ChatReplyReceiptSchema = z.strictObject({
	requestId: IdSchema,
	source: ChatSourceSchema,
	bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
	deliveredAt: DateTimeSchema,
});
export type ChatSource = z.infer<typeof ChatSourceSchema>;
export type SourceAudience = z.infer<typeof SourceAudienceSchema>;
export type ChatCitation = z.infer<typeof ChatCitationSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatConversation = z.infer<typeof ChatConversationSchema>;
export type ChatReplyReceipt = z.infer<typeof ChatReplyReceiptSchema>;

export const SlackConversationPageSchema = z.strictObject({
	items: z.array(ChatConversationSchema).max(15),
	nextCursor: z.string().max(2000).nullable(),
	hasMore: z.boolean(),
});
export const SlackMessagePageSchema = z
	.strictObject({
		actor: z.strictObject({ workspaceId: IdSchema, userId: IdSchema }),
		conversation: ChatConversationSchema,
		items: z.array(ChatMessageSchema).max(15),
		authors: z.array(z.strictObject({ id: IdSchema, name: z.string().min(1).max(300) })).max(15),
		threadTs: z.string().max(30).nullable(),
		nextCursor: z.string().max(2000).nullable(),
		hasMore: z.boolean(),
	})
	.superRefine((page, ctx) => {
		if (
			page.actor.workspaceId !== page.conversation.workspaceId ||
			page.items.some(
				(message) =>
					message.citation.source.workspaceId !== page.actor.workspaceId ||
					message.citation.source.conversationId !== page.conversation.id ||
					(page.threadTs !== null &&
						(message.citation.source.threadId ?? message.citation.source.messageId) !==
							page.threadTs)
			)
		)
			ctx.addIssue({ code: "custom", message: "Slack message page identity mismatch" });
		if (
			new Set(page.authors.map((author) => author.id)).size !== page.authors.length ||
			page.authors.some((author) => !page.items.some((message) => message.authorId === author.id))
		)
			ctx.addIssue({ code: "custom", message: "Author labels must belong to observed messages" });
	});
export type SlackConversationPage = z.infer<typeof SlackConversationPageSchema>;
export type SlackMessagePage = z.infer<typeof SlackMessagePageSchema>;
export const SlackViewTargetSchema = z.strictObject({
	conversationId: z
		.string()
		.min(2)
		.max(100)
		.regex(/^[A-Z][A-Z0-9]+$/),
	threadTs: z
		.string()
		.regex(/^\d{1,16}\.\d{6}$/)
		.nullable(),
});
/** Center canvas selection, including a thread when present; no source text or permissions encoded. */
export function encodeSlackViewTarget(value: z.infer<typeof SlackViewTargetSchema>): string {
	const target = SlackViewTargetSchema.parse(value);
	return target.threadTs ? `${target.conversationId}/${target.threadTs}` : target.conversationId;
}
export function decodeSlackViewTarget(value: string): z.infer<typeof SlackViewTargetSchema> {
	const parts = value.split("/");
	if (parts.length > 2) throw new Error("Invalid Slack view target");
	return SlackViewTargetSchema.parse({ conversationId: parts[0], threadTs: parts[1] ?? null });
}

export const SlackFollowConfigurationSchema = z.strictObject({
	mode: z.enum(["all_joined", "selected"]),
	excludedConversationIds: z.array(IdSchema).max(1000),
});
export const SlackMembershipSyncSchema = z.strictObject({
	phase: z.enum(["pending", "syncing", "complete", "error", "capacity"]),
	discoveredCount: z.int().nonnegative(),
	completedAt: DateTimeSchema.nullable(),
});
export type SlackFollowConfiguration = z.infer<typeof SlackFollowConfigurationSchema>;
export type SlackMembershipSync = z.infer<typeof SlackMembershipSyncSchema>;
export const SlackConnectionStatusSchema = z.strictObject({
	phase: z.enum(["disconnected", "checking", "connected", "error"]),
	account: z
		.strictObject({
			workspaceId: IdSchema,
			workspaceName: z.string().max(300),
			userId: IdSchema,
			userName: z.string().max(300),
		})
		.nullable(),
	missing: z.array(z.enum(["SLACK_USER_TOKEN", "SLACK_APP_ID"])).max(2),
	coverage: z.enum(["disconnected", "paused", "bounded-poll", "socket"]),
	watching: z.array(IdSchema).max(1000),
	followMode: z.enum(["all_joined", "selected"]).default("selected"),
	excludedConversationIds: z.array(IdSchema).max(1000).default([]),
	membershipSync: SlackMembershipSyncSchema.optional(),
	error: z.enum(["configuration", "authentication", "source-unavailable"]).nullable(),
});
export type SlackConnectionStatus = z.infer<typeof SlackConnectionStatusSchema>;
