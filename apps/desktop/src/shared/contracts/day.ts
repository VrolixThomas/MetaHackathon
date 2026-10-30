import { z } from "zod";
import { ChatCitationSchema, ChatReplyReceiptSchema } from "./chat";
import { CommitShaSchema, DateTimeSchema, IdSchema } from "./common";

export const DayActorSchema = z.strictObject({ workspaceId: IdSchema, userId: IdSchema });
export const DayPhaseSchema = z.enum([
	"captured",
	"preparing",
	"needs_context",
	"ready",
	"working",
	"ready_review",
	"awaiting_reply",
	"closed",
	"cancelled",
]);
export const DayQuestionSchema = z.strictObject({
	id: IdSchema,
	question: z.string().min(1).max(4000),
	answer: z.string().max(12000).nullable(),
	answeredAt: DateTimeSchema.nullable(),
});
export const DayWorkItemSchema = z
	.strictObject({
		id: IdSchema,
		revision: z.int().positive(),
		workspaceId: IdSchema,
		ownerUserId: IdSchema,
		requestedById: IdSchema.nullable(),
		kind: z.enum(["request", "promise", "follow_up", "coding"]),
		title: z.string().min(1).max(300),
		summary: z.string().max(12000),
		source: ChatCitationSchema.nullable(),
		acceptance: z.enum(["pending", "accepted", "declined"]),
		acceptanceBasis: z.enum(["none", "user_action", "own_explicit_promise"]),
		acceptedAt: DateTimeSchema.nullable(),
		phase: DayPhaseSchema,
		priority: z.strictObject({
			rank: z.int().min(0).max(100),
			reason: z.string().max(2000),
			provenance: z.literal("inferred"),
		}),
		questions: z.array(DayQuestionSchema).max(30),
		jobId: IdSchema.nullable(),
		repositoryId: IdSchema.nullable(),
		linearIssueId: IdSchema.nullable(),
		nextCheckAt: DateTimeSchema.nullable(),
		reviewedAt: DateTimeSchema.nullable(),
		reviewedHeadSha: CommitShaSchema.nullable(),
		replyDraft: z
			.strictObject({ revision: z.int().positive(), body: z.string().min(1).max(40000) })
			.nullable(),
		answerReceipt: ChatReplyReceiptSchema.nullable(),
		createdAt: DateTimeSchema,
		updatedAt: DateTimeSchema,
	})
	.superRefine((row, ctx) => {
		const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
		if (row.source && row.source.source.workspaceId !== row.workspaceId)
			invalid("Work item source belongs to another workspace");
		if (row.acceptance === "accepted" && (!row.acceptedAt || row.acceptanceBasis === "none"))
			invalid("Acceptance requires a recorded basis and time");
		if (row.acceptance !== "accepted" && row.acceptedAt)
			invalid("Unaccepted work cannot record acceptance");
		if (
			["working", "ready_review", "awaiting_reply", "closed"].includes(row.phase) &&
			row.acceptance !== "accepted"
		)
			invalid("Execution and delivery require accepted ownership");
		if (row.phase === "closed" && !row.answerReceipt)
			invalid("A commitment closes only after delivered answer evidence");
		if (
			row.answerReceipt &&
			(!row.source ||
				row.answerReceipt.source.workspaceId !== row.workspaceId ||
				row.answerReceipt.source.conversationId !== row.source.source.conversationId ||
				(row.answerReceipt.source.threadId ?? row.answerReceipt.source.messageId) !==
					(row.source.source.threadId ?? row.source.source.messageId))
		)
			invalid("Answer receipt must belong to the original source thread");
	});
export const DaySnapshotSchema = z
	.strictObject({
		sequence: z.int().nonnegative(),
		actor: DayActorSchema,
		items: z.array(DayWorkItemSchema).max(1000),
		currentItemId: IdSchema.nullable(),
		supervisor: z.enum(["running", "paused", "stopped"]),
		errors: z
			.array(
				z.enum(["source_unavailable", "storage_unavailable", "worker_unavailable", "reply_failed"])
			)
			.max(10),
	})
	.refine(
		(row) =>
			row.items.every(
				(item) =>
					item.workspaceId === row.actor.workspaceId && item.ownerUserId === row.actor.userId
			),
		"A day snapshot cannot include another user's private work"
	);
const versioned = { itemId: IdSchema, expectedRevision: z.int().positive() };
export const DayOperationSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("accept"), ...versioned }),
	z.strictObject({ kind: z.literal("decline"), ...versioned }),
	z.strictObject({ kind: z.literal("cover"), ...versioned }),
	z.strictObject({
		kind: z.literal("answer_question"),
		...versioned,
		questionId: IdSchema,
		answer: z.string().min(1).max(12000),
	}),
	z.strictObject({ kind: z.literal("start_work"), ...versioned, repositoryId: IdSchema }),
	z.strictObject({ kind: z.literal("pause_work"), ...versioned }),
	z.strictObject({ kind: z.literal("resume_work"), ...versioned }),
	z.strictObject({ kind: z.literal("cancel"), ...versioned }),
	z.strictObject({
		kind: z.literal("mark_reviewed"),
		...versioned,
		headSha: CommitShaSchema.nullable(),
	}),
	z.strictObject({
		kind: z.literal("draft_reply"),
		...versioned,
		body: z.string().min(1).max(40000),
	}),
	z.strictObject({
		kind: z.literal("send_reply"),
		...versioned,
		draftRevision: z.int().positive(),
		body: z.string().min(1).max(40000),
	}),
	z.strictObject({ kind: z.literal("link_linear"), ...versioned, issueId: IdSchema }),
	z.strictObject({
		kind: z.literal("capture_manual"),
		title: z.string().min(1).max(300),
		summary: z.string().max(12000),
		itemKind: z.enum(["promise", "follow_up", "coding"]),
	}),
]);
export const DayOperateInputSchema = z.strictObject({
	requestId: IdSchema,
	operation: DayOperationSchema,
});
export const DayOperationResultSchema = z.strictObject({
	requestId: IdSchema,
	snapshot: DaySnapshotSchema,
	itemId: IdSchema.nullable(),
});
export type DayActor = z.infer<typeof DayActorSchema>;
export type DayPhase = z.infer<typeof DayPhaseSchema>;
export type DayQuestion = z.infer<typeof DayQuestionSchema>;
export type DayWorkItem = z.infer<typeof DayWorkItemSchema>;
export type DaySnapshot = z.infer<typeof DaySnapshotSchema>;
export type DayOperation = z.infer<typeof DayOperationSchema>;
export type DayOperateInput = z.infer<typeof DayOperateInputSchema>;
export type DayOperationResult = z.infer<typeof DayOperationResultSchema>;
