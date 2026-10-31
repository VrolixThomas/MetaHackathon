import { z } from "zod";
import { PullRequestFeedbackSchema, WorkCheckSchema, WorkReviewSchema } from "./command-center";
import { CodeLocationSchema, CommitShaSchema, IdSchema, RepositoryPathSchema } from "./common";
import { PullRequestSchema } from "./review";

export const PRCommentCreateInputSchema = z.strictObject({
	requestId: IdSchema,
	prId: IdSchema,
	reviewId: IdSchema,
	headSha: CommitShaSchema,
	body: z.string().min(1).max(20000),
	location: CodeLocationSchema.optional(),
});
export const PRCommentEditInputSchema = z.strictObject({
	draftId: IdSchema,
	body: z.string().min(1).max(20000),
});
export const PRFixStartInputSchema = z.strictObject({
	requestId: IdSchema.max(200),
	prId: IdSchema,
	feedbackId: IdSchema,
});
/** A local candidate is separate from review, author approval, publication and merge. */
export const PRFixSummarySchema = z.strictObject({
	id: IdSchema.max(200),
	jobId: IdSchema,
	pr: PullRequestSchema,
	feedback: PullRequestFeedbackSchema,
	phase: z.enum([
		"preparing",
		"prepared",
		"executing",
		"ready",
		"needs-input",
		"failed",
		"interrupted",
	]),
	summary: z.string().max(12000),
	question: z.string().max(6000).nullable(),
	baseSha: CommitShaSchema,
	headSha: CommitShaSchema.nullable(),
	checks: z.array(WorkCheckSchema).max(100),
	changedFiles: z.array(RepositoryPathSchema).max(300),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	reviewedAt: z.iso.datetime().nullable(),
	error: z.string().max(1000).nullable(),
	publication: z.literal("not-published"),
});
export const PRFixDetailSchema = z.strictObject({
	fix: PRFixSummarySchema,
	review: WorkReviewSchema.nullable(),
});
export const PRFixReviewInputSchema = z.strictObject({
	id: IdSchema.max(200),
	headSha: CommitShaSchema,
	confirmed: z.literal(true),
});
export type PRCommentCreateInput = z.infer<typeof PRCommentCreateInputSchema>;
export type PRFixStartInput = z.infer<typeof PRFixStartInputSchema>;
export type PRFixSummary = z.infer<typeof PRFixSummarySchema>;
export type PRFixDetail = z.infer<typeof PRFixDetailSchema>;
export type PRFixReviewInput = z.infer<typeof PRFixReviewInputSchema>;
