import { z } from "zod";
import { CommitShaSchema, IdSchema, RepositoryPathSchema } from "./common";
import { PullRequestSchema } from "./review";

/** Exact source conditions authorize only the specified complete UTF-8 file bytes.
 * Judgment is intentionally human-only; inference can never establish a passing check. */
export const ApprovalConditionSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("check"),
		name: z.string().trim().min(1).max(200),
		appId: z.int().positive().nullable(),
	}),
	z.strictObject({
		kind: z.literal("source"),
		path: RepositoryPathSchema.max(4096),
		expectedContent: z.string().max(30000),
		reason: z.string().trim().min(1).max(1000),
	}),
	z.strictObject({ kind: z.literal("judgment"), description: z.string().trim().min(1).max(1000) }),
]);
export const ApprovalTermsSchema = z
	.strictObject({
		action: z.enum(["approve", "notify"]),
		expiresAt: z.iso.datetime(),
		conditions: z.array(ApprovalConditionSchema).min(1).max(10),
	})
	.refine(
		(t) =>
			new Set(
				t.conditions.map((c) =>
					c.kind === "check"
						? `check:${c.name}`
						: c.kind === "source"
							? `source:${c.path}`
							: `judgment:${c.description}`
				)
			).size === t.conditions.length,
		"Duplicate conditions"
	)
	.refine(
		(t) => JSON.stringify(t).length <= 24000,
		"Policy exceeds the bounded presentation size; narrow its conditions"
	);
export const ApprovalPolicySchema = z.strictObject({
	id: IdSchema,
	connectionId: z.string().regex(/^[a-f0-9]{64}$/),
	revision: z.int().positive(),
	actor: z.strictObject({ id: z.int().positive(), login: z.string().min(1).max(100) }),
	pr: PullRequestSchema,
	reviewId: IdSchema,
	contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
	terms: ApprovalTermsSchema,
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	createdAt: z.iso.datetime(),
	confirmedAt: z.iso.datetime().nullable(),
	status: z.enum([
		"draft",
		"monitoring",
		"paused",
		"offline",
		"expired",
		"needs-review",
		"notified",
		"submitting",
		"approved",
		"uncertain",
		"revoked",
	]),
	evaluation: z
		.strictObject({
			at: z.iso.datetime(),
			headSha: CommitShaSchema,
			outcome: z.enum(["waiting", "satisfied", "needs-review"]),
			explanation: z.string().max(3000),
			evidence: z
				.array(
					z.strictObject({
						condition: z.string().max(4096),
						kind: z.enum(["source", "github-check", "inference"]),
						satisfied: z.boolean(),
						detail: z.string().max(2000),
						url: z.url().max(2048).nullable(),
						providerId: z.int().positive().nullable().optional(),
					})
				)
				.max(100),
		})
		.nullable(),
	attempt: z
		.strictObject({
			id: IdSchema,
			headSha: CommitShaSchema,
			startedAt: z.iso.datetime(),
			receipt: z.strictObject({ id: z.int().positive(), url: z.url().max(2048) }).nullable(),
		})
		.nullable(),
});
export const ApprovalDraftInputSchema = z
	.strictObject({
		sessionId: IdSchema,
		terms: ApprovalTermsSchema,
		id: IdSchema.optional(),
		revision: z.int().positive().optional(),
	})
	.refine(
		(p) => (p.id === undefined) === (p.revision === undefined),
		"Edits require the exact policy ID and revision"
	);
export const ApprovalIdentitySchema = z.strictObject({
	id: IdSchema,
	revision: z.int().positive(),
});
export const ApprovalConfirmInputSchema = ApprovalIdentitySchema.extend({
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	confirmed: z.literal(true),
});
export const ApprovalPresentationSchema = z.strictObject({
	sessionId: IdSchema,
	id: IdSchema,
	revision: z.int().positive(),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export type ApprovalTerms = z.infer<typeof ApprovalTermsSchema>;
export type ApprovalDraftInput = z.infer<typeof ApprovalDraftInputSchema>;
export type ApprovalConfirmInput = z.infer<typeof ApprovalConfirmInputSchema>;
