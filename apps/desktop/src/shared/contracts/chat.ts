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
