import { z } from "zod";
import { CodeLocationSchema, CommitShaSchema, IdSchema, RepositoryPathSchema } from "./common";
import { PullRequestSchema } from "./review";

export const GitHubRepositorySchema = z
	.string()
	.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
	.refine((value) => value.split("/").every((part) => part !== "." && part !== ".."));
export const ReviewSuggestionSchema = z.strictObject({
	id: IdSchema,
	body: z.string().min(1).max(4000),
	location: CodeLocationSchema.optional(),
});
export const ReviewPlanFileSchema = z.strictObject({
	path: RepositoryPathSchema,
	reason: z.string().min(1).max(2000),
	summary: z.string().min(1).max(4000),
	suggestedComments: z.array(ReviewSuggestionSchema).max(8),
});
export const PreparedReviewSchema = z
	.strictObject({
		id: IdSchema,
		version: z.literal(1),
		pr: PullRequestSchema,
		createdAt: z.iso.datetime(),
		summary: z.string().min(1).max(8000),
		orderRationale: z.string().min(1).max(4000),
		files: z.array(ReviewPlanFileSchema).max(100),
		coverage: z.enum(["complete", "partial"]),
		// Suggested explanations/comments are inferences. Preparation does not execute or post.
		evidence: z.literal("inferred-from-github"),
	})
	.refine(
		(review) => new Set(review.files.map((file) => file.path)).size === review.files.length,
		"Review order must contain unique files"
	);
export const ReviewProgressSchema = z.strictObject({
	reviewId: IdSchema,
	prId: IdSchema,
	baseSha: CommitShaSchema,
	headSha: CommitShaSchema,
	path: RepositoryPathSchema.nullable(),
	visited: z.array(RepositoryPathSchema).max(100),
	paused: z.boolean(),
	updatedAt: z.iso.datetime(),
});
export const ReviewScreenSchema = z.strictObject({
	sequence: z.int().nonnegative(),
	mode: z.enum(["conversation", "review"]),
	prId: IdSchema.nullable(),
	reviewId: IdSchema.optional(),
	path: RepositoryPathSchema.optional(),
	baseSha: CommitShaSchema.optional(),
	headSha: CommitShaSchema.optional(),
});
export const ReviewNavigationSchema = z.strictObject({
	reviewId: IdSchema,
	prId: IdSchema,
	baseSha: CommitShaSchema,
	headSha: CommitShaSchema,
	path: RepositoryPathSchema,
	paused: z.boolean(),
	highlight: CodeLocationSchema.optional(),
});
export const ReviewDetailSchema = z.strictObject({
	pr: PullRequestSchema,
	status: z.enum(["queued", "preparing", "ready", "error"]),
	prepared: PreparedReviewSchema.nullable(),
	progress: ReviewProgressSchema.nullable(),
	error: z.string().max(500).optional(),
});
export const ReviewInboxSchema = z.strictObject({
	repository: GitHubRepositorySchema.nullable(),
	localPath: z.string().min(1).nullable().default(null),
	items: z.array(ReviewDetailSchema).max(200),
	refreshing: z.boolean(),
	lastRefreshedAt: z.iso.datetime().nullable(),
	error: z.string().max(500).optional(),
});
export const ReviewFileRequestSchema = z.strictObject({
	prId: IdSchema,
	reviewId: IdSchema,
	path: RepositoryPathSchema,
});
export const PinnedReviewFileRequestSchema = z.strictObject({
	prId: IdSchema,
	baseSha: CommitShaSchema,
	headSha: CommitShaSchema,
	path: RepositoryPathSchema,
});
export const ReviewSourceSchema = z.strictObject({
	path: RepositoryPathSchema,
	commitSha: CommitShaSchema,
	status: z.enum(["available", "missing", "binary", "too-large"]),
	content: z.string().max(300_000).nullable(),
});
export const ReviewFileSchema = z.strictObject({
	prId: IdSchema,
	path: RepositoryPathSchema,
	status: z.string(),
	patch: z.string().max(100_000).nullable(),
	base: ReviewSourceSchema,
	head: ReviewSourceSchema,
});
export const ReviewCacheSchema = z.strictObject({
	repository: GitHubRepositorySchema.nullable(),
	localPath: z.string().min(1).nullable().default(null),
	prepared: z.array(PreparedReviewSchema).max(200),
	progress: z.array(ReviewProgressSchema).max(200),
});
export type PreparedReview = z.infer<typeof PreparedReviewSchema>;
export type ReviewPlanFile = z.infer<typeof ReviewPlanFileSchema>;
export type ReviewProgress = z.infer<typeof ReviewProgressSchema>;
export type ReviewScreen = z.infer<typeof ReviewScreenSchema>;
export type ReviewNavigation = z.infer<typeof ReviewNavigationSchema>;
export type ReviewDetail = z.infer<typeof ReviewDetailSchema>;
export type ReviewInbox = z.infer<typeof ReviewInboxSchema>;
export type ReviewFile = z.infer<typeof ReviewFileSchema>;
export type PinnedReviewFileRequest = z.infer<typeof PinnedReviewFileRequestSchema>;
export type ReviewCache = z.infer<typeof ReviewCacheSchema>;
