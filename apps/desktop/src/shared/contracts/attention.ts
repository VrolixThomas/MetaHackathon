import { z } from "zod";
import { CommitShaSchema, IdSchema } from "./common";
import { TurnIdentitySchema } from "./interaction";
import { GitHubRepositorySchema } from "./prepared-review";

/** Presence reports delivery eligibility; it never grants authority to edit or publish work. */
export const AttentionPresenceSchema = z.strictObject({
	sessionId: IdSchema,
	enabled: z.boolean(),
	state: z.enum(["idle", "user-speaking", "responding", "interacting", "disabled"]),
	focused: z.boolean(),
	obscured: z.boolean(),
	activitySequence: z.int().nonnegative(),
	/** Absent means false for older clients. Visible acknowledged code/work review panes only. */
	reviewingCode: z.boolean().optional(),
});
export const AttentionItemSchema = z
	.strictObject({
		noticeId: IdSchema,
		kind: z.enum(["decision", "work-failed", "work-ready", "clarification", "pr-approval"]),
		jobId: IdSchema.nullable(),
		repository: GitHubRepositorySchema.nullable(),
		dayItemId: IdSchema.optional(),
		label: z.string().min(1).max(300),
		headSha: CommitShaSchema.nullable(),
		decisionId: IdSchema.nullable(),
		question: z.string().max(2000).nullable(),
		changedFileCount: z.int().nonnegative(),
		applied: z.boolean(),
	})
	.refine(
		(item) =>
			item.kind === "clarification"
				? !!item.dayItemId && item.jobId === null && item.repository === null
				: item.jobId !== null && item.repository !== null && item.dayItemId === undefined,
		"Attention must distinguish actual jobs from source-only Day clarification"
	);
export const AttentionClaimSchema = z
	.strictObject({
		id: IdSchema,
		sessionId: IdSchema,
		items: z.array(AttentionItemSchema).min(1).max(2),
		createdAt: z.iso.datetime(),
		expiresAt: z.iso.datetime(),
	})
	.refine(
		(claim) =>
			new Set(claim.items.map((item) => item.dayItemId ?? item.jobId)).size === claim.items.length,
		{
			message: "One attention item per job",
		}
	);
export const AttentionPollResultSchema = z.strictObject({ claim: AttentionClaimSchema.nullable() });
/** Assistant initiative has an explicit entry point and never invents a user utterance. */
export const ConversationAttentionInputSchema = z.strictObject({
	...TurnIdentitySchema.shape,
	requestId: IdSchema,
	claimId: IdSchema,
});
export const AttentionSettleInputSchema = z.strictObject({
	...TurnIdentitySchema.shape,
	claimId: IdSchema,
	status: z.enum(["spoken", "interrupted", "failed"]),
});
export const AttentionReleaseInputSchema = z.strictObject({
	sessionId: IdSchema,
	claimId: IdSchema,
});
export const AttentionReceiptResultSchema = z.strictObject({
	status: z.enum(["accepted", "stale"]),
});

export type AttentionPresence = z.infer<typeof AttentionPresenceSchema>;
export type AttentionItem = z.infer<typeof AttentionItemSchema>;
export type AttentionClaim = z.infer<typeof AttentionClaimSchema>;
export type ConversationAttentionInput = z.infer<typeof ConversationAttentionInputSchema>;
export type AttentionSettleInput = z.infer<typeof AttentionSettleInputSchema>;
