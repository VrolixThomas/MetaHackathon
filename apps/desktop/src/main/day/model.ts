import { createHash } from "node:crypto";
import { z } from "zod";
import { IdSchema, LinearTicketSchema, WorkJobSchema } from "../../shared/contracts";
import {
	ChatMessageSchema,
	ChatReplyReceiptSchema,
	type ChatSource,
	ChatSourceSchema,
} from "../../shared/contracts/chat";
import {
	ClarificationPolicySchema,
	DayActorSchema,
	DayWorkItemSchema,
} from "../../shared/contracts/day";

const time = z.iso.datetime();
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export const sourceKey = (source: ChatSource): string =>
	sha256(
		JSON.stringify([source.provider, source.workspaceId, source.conversationId, source.messageId])
	);
export const DayCaptureSchema = z.strictObject({
	requestId: IdSchema,
	message: ChatMessageSchema,
	kind: z.enum(["request", "promise", "follow_up", "coding"]),
	title: z.string().min(1).max(300),
	summary: z.string().max(12000),
	repositoryId: IdSchema.nullable().default(null),
});
export type DayCapture = z.input<typeof DayCaptureSchema>;
export const DayOutboxSchema = z
	.strictObject({
		clarification: z
			.strictObject({
				policyId: IdSchema,
				policyRevision: z.int().positive(),
				connectionId: IdSchema,
				threadDigest: z.string(),
				standingAuthority: ClarificationPolicySchema.shape.standingAuthority,
			})
			.optional(),
		requestId: IdSchema,
		source: ChatSourceSchema,
		body: z.string().min(1).max(40000),
		bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
		draftRevision: z.int().positive(),
		confirmedAt: time.nullable(),
		status: z.enum(["pending", "uncertain", "delivered"]),
		superseded: z.boolean(),
		attempts: z.int().nonnegative(),
		lastAttemptAt: time.nullable(),
		providerKey: z.string().min(1).max(500).nullable().default(null),
		providerBindingDigest: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.nullable()
			.default(null),
		receipt: ChatReplyReceiptSchema.nullable(),
	})
	.superRefine((outbox, ctx) => {
		if ((outbox.confirmedAt === null) !== Boolean(outbox.clarification?.standingAuthority)) {
			ctx.addIssue({
				code: "custom",
				path: ["confirmedAt"],
				message:
					"Standing authority requires a null per-thread confirmation; ordinary replies require confirmation.",
			});
		}
	});
export type DayOutbox = z.infer<typeof DayOutboxSchema>;
export const DayRecordSchema = z.strictObject({
	item: DayWorkItemSchema,
	clarificationRetryAt: time.optional(),
	sourceUpdatedAt: time.nullable(),
	sourceDigest: z.string().nullable(),
	sourceFence: z
		.strictObject({ revisionId: IdSchema, updatedAt: time, deleted: z.boolean() })
		.optional(),
	sourceText: z.string().max(40000).nullable(),
	sourceDeleted: z.boolean(),
	preparation: z
		.strictObject({
			requestId: IdSchema,
			sourceRevision: IdSchema.nullable(),
			job: WorkJobSchema.nullable(),
			executionRequested: z.boolean(),
			executionDeliveredAt: time.nullable(),
		})
		.nullable(),
	questionDeliveries: z
		.array(
			z.strictObject({
				questionId: IdSchema,
				jobId: IdSchema.nullable(),
				decisionId: IdSchema.nullable(),
				origin: z.enum(["worker-decision", "inferred-context"]),
				presentedAt: time.nullable(),
				deliveredAt: time.nullable(),
			})
		)
		.max(30),
	controls: z
		.array(
			z.strictObject({
				requestId: IdSchema,
				jobId: IdSchema,
				kind: z.enum(["pause", "resume", "cancel"]),
				deliveredAt: time.nullable(),
			})
		)
		.max(100),
	paused: z.boolean(),
	linear: LinearTicketSchema.nullable(),
	outbox: z.array(DayOutboxSchema).max(100),
	checkpoint: z.strictObject({
		lastAttemptAt: time.nullable(),
		lastCompletedAt: time.nullable(),
		failures: z.int().nonnegative(),
		error: z.enum(["worker_unavailable", "reply_failed", "source_unavailable"]).nullable(),
	}),
});
export type DayRecord = z.infer<typeof DayRecordSchema>;
export const DaySupervisorCheckpointSchema = z.strictObject({
	mode: z.enum(["idle", "checking", "backoff", "sleeping", "offline", "stopped"]),
	nextCheckAt: time,
	lastStartedAt: time.nullable(),
	lastCompletedAt: time.nullable(),
	failures: z.int().nonnegative(),
});
export type DaySupervisorCheckpoint = z.infer<typeof DaySupervisorCheckpointSchema>;
export const DayStateSchema = z.strictObject({
	version: z.literal(1),
	sequence: z.int().nonnegative(),
	records: z.array(DayRecordSchema).max(1000),
	requests: z
		.array(
			z.strictObject({
				id: IdSchema,
				actor: DayActorSchema,
				digest: z.string().regex(/^[a-f0-9]{64}$/),
				itemId: IdSchema,
			})
		)
		.max(10000),
	current: z.array(z.strictObject({ actor: DayActorSchema, itemId: IdSchema })).max(100),
	supervisor: DaySupervisorCheckpointSchema,
});
export type DayState = z.infer<typeof DayStateSchema>;
export function emptyDayState(now: string): DayState {
	return {
		version: 1,
		sequence: 0,
		records: [],
		requests: [],
		current: [],
		supervisor: {
			mode: "stopped",
			nextCheckAt: now,
			lastStartedAt: null,
			lastCompletedAt: null,
			failures: 0,
		},
	};
}
export function replyMatches(
	reply: DayOutbox,
	receipt: z.infer<typeof ChatReplyReceiptSchema>
): boolean {
	return (
		receipt.requestId === reply.requestId &&
		receipt.bodyDigest === reply.bodyDigest &&
		receipt.source.messageId !== reply.source.messageId &&
		receipt.source.workspaceId === reply.source.workspaceId &&
		receipt.source.conversationId === reply.source.conversationId &&
		(receipt.source.threadId ?? receipt.source.messageId) ===
			(reply.source.threadId ?? reply.source.messageId)
	);
}
/** Cross-record invariants apply equally to service mutations and persisted SQLite bytes. */
export function parseDayState(raw: unknown): DayState {
	const state = DayStateSchema.parse(raw);
	const unique = (values: string[]) => {
		if (new Set(values).size !== values.length) throw new Error("Duplicate day identity");
	};
	const actorKey = (actor: { workspaceId: string; userId: string }) =>
		JSON.stringify([actor.workspaceId, actor.userId]);
	unique(state.records.map(({ item }) => item.id));
	unique(
		state.records.flatMap(({ item }) =>
			item.source ? [`${item.ownerUserId}:${sourceKey(item.source.source)}`] : []
		)
	);
	unique(state.requests.map((request) => `${actorKey(request.actor)}:${request.id}`));
	unique(state.current.map((current) => actorKey(current.actor)));
	unique(state.records.flatMap((record) => record.outbox.map((reply) => reply.requestId)));
	for (const request of [...state.requests, ...state.current])
		if (
			!state.records.some(
				({ item }) =>
					item.id === request.itemId &&
					item.workspaceId === request.actor.workspaceId &&
					item.ownerUserId === request.actor.userId
			)
		)
			throw new Error("Unknown day request item");
	for (const record of state.records) {
		const { item, preparation } = record;
		const clarification = item.clarification;
		if (clarification) {
			const policy = clarification.policy;
			if (
				policy.actor.workspaceId !== item.workspaceId ||
				policy.actor.userId !== item.ownerUserId ||
				!item.source ||
				sourceKey(policy.source) !== sourceKey(item.source.source)
			)
				throw new Error("Clarification owner/source mismatch");
			for (const attempt of clarification.attempts) {
				const outbox = record.outbox.find((reply) => reply.requestId === attempt.requestId);
				if (
					!outbox?.clarification ||
					outbox.clarification.policyId !== policy.id ||
					outbox.bodyDigest !== attempt.bodyDigest ||
					sha256(attempt.body) !== attempt.bodyDigest ||
					outbox.status !== attempt.status ||
					JSON.stringify(outbox.receipt) !== JSON.stringify(attempt.receipt)
				)
					throw new Error("Clarification ledger mismatch");
			}
		}
		if (
			item.acceptanceBasis === "own_explicit_promise" &&
			(item.acceptance !== "accepted" ||
				item.requestedById !== item.ownerUserId ||
				item.kind !== "promise")
		)
			throw new Error("Day promise attribution mismatch");
		if (record.sourceDeleted && (record.sourceText !== null || item.phase !== "cancelled"))
			throw new Error("Deleted day source retained readable content");
		unique(item.questions.map((question) => question.id));
		unique(record.questionDeliveries.map((question) => question.questionId));
		unique(record.controls.map((control) => control.requestId));
		if (
			preparation &&
			(preparation.sourceRevision !== (item.source?.source.revisionId ?? null) ||
				(preparation.job && preparation.job.id !== item.jobId))
		)
			throw new Error("Day worker mismatch");
		if (preparation?.job) {
			const internal = preparation.job.internal;
			if (
				!internal ||
				internal.workspaceId !== item.workspaceId ||
				internal.ownerUserId !== item.ownerUserId ||
				internal.itemId !== item.id ||
				internal.requestId !== preparation.requestId
			)
				throw new Error("Day worker origin mismatch");
		}
		if (
			item.reviewedAt &&
			(item.acceptance !== "accepted" ||
				(preparation?.job &&
					(preparation.job.state !== "ready" ||
						preparation.job.internal?.stage !== "admitted" ||
						item.reviewedHeadSha !== preparation.job.headSha)))
		)
			throw new Error("Day review mismatch");
		if (record.linear?.id !== (item.linearIssueId ?? undefined))
			throw new Error("Day Linear identity mismatch");
		for (const question of item.questions)
			if ((question.answer === null) !== (question.answeredAt === null))
				throw new Error("Day question mismatch");
		for (const delivery of record.questionDeliveries)
			if (
				(delivery.jobId === null) !== (delivery.decisionId === null) ||
				(delivery.origin === "inferred-context") !== (delivery.jobId === null)
			)
				throw new Error("Day context origin mismatch");
		for (const delivery of record.questionDeliveries)
			if (
				!item.questions.some(
					(question) =>
						question.id === delivery.questionId && (!delivery.deliveredAt || question.answeredAt)
				)
			)
				throw new Error("Day question delivery mismatch");
		for (const reply of record.outbox) {
			if (
				(reply.providerKey === null) !== (reply.providerBindingDigest === null) ||
				(reply.providerBindingDigest &&
					reply.providerBindingDigest !== sha256(JSON.stringify([reply.source, reply.body])))
			)
				throw new Error("Day provider reservation mismatch");
			if (
				!item.source ||
				sourceKey(reply.source) !== sourceKey(item.source.source) ||
				reply.bodyDigest !== sha256(reply.body) ||
				(reply.status === "delivered") !== (reply.receipt !== null) ||
				(reply.receipt && !replyMatches(reply, reply.receipt))
			)
				throw new Error("Day receipt mismatch");
		}
		if (
			item.answerReceipt &&
			!record.outbox.some(
				(reply) =>
					!reply.clarification &&
					!reply.superseded &&
					reply.status === "delivered" &&
					reply.source.revisionId === item.source?.source.revisionId &&
					JSON.stringify(reply.receipt) === JSON.stringify(item.answerReceipt)
			)
		)
			throw new Error("Day closure has no current outbox receipt");
		if (
			item.phase === "closed" &&
			(record.sourceDeleted || item.questions.some((question) => question.answer === null))
		)
			throw new Error("Day closure has unresolved context");
	}
	return state;
}
