import { z } from "zod";
import { PullRequestFeedbackSchema, WorkCheckSchema } from "./command-center";
import { CommitShaSchema, IdSchema, RepositoryPathSchema } from "./common";
import { PreparedReviewSchema } from "./prepared-review";

export const TeamReviewKeySchema = z.strictObject({
	orgId: z.uuid(),
	repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
	prNumber: z.int().positive(),
	baseSha: CommitShaSchema,
	headSha: CommitShaSchema,
	contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
	analysisVersion: z.string().min(1).max(100),
});
export const TeamReviewArtifactSchema = z.strictObject({
	key: TeamReviewKeySchema,
	review: PreparedReviewSchema,
	digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const TeamProgressSchema = z.strictObject({
	key: TeamReviewKeySchema,
	cursor: z.string().max(4096).nullable(),
	notes: z.string().max(20000),
	revision: z.int().nonnegative(),
});
export const TeamProposalBundleSchema = z.strictObject({
	key: TeamReviewKeySchema,
	feedback: PullRequestFeedbackSchema,
	feedbackRevision: z.string().regex(/^[a-f0-9]{64}$/),
	baseSha: CommitShaSchema,
	candidateSha: CommitShaSchema,
	files: z
		.array(
			z.strictObject({
				path: RepositoryPathSchema,
				baseContent: z
					.string()
					.max(1024 * 1024)
					.nullable(),
				candidateContent: z
					.string()
					.max(1024 * 1024)
					.nullable(),
				baseSha256: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.nullable(),
				candidateSha256: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.nullable(),
			})
		)
		.min(1)
		.max(100),
	patch: z.string().max(2 * 1024 * 1024),
	patchSha256: z.string().regex(/^[a-f0-9]{64}$/),
	checks: z.array(WorkCheckSchema).max(100),
	checksSha256: z.string().regex(/^[a-f0-9]{64}$/),
	executionOrigin: z.literal("developer-device"),
});
export const TeamProposalDecisionSchema = z.strictObject({
	proposalId: z.uuid(),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	headSha: CommitShaSchema,
	decision: z.enum(["accepted", "changes-requested"]),
	comment: z.string().max(6000),
	requestId: IdSchema.max(200),
});
export type TeamReviewKey = z.infer<typeof TeamReviewKeySchema>;
export type TeamReviewArtifact = z.infer<typeof TeamReviewArtifactSchema>;
export type TeamProgress = z.infer<typeof TeamProgressSchema>;
export type TeamProposalBundle = z.infer<typeof TeamProposalBundleSchema>;
export type TeamProposalDecision = z.infer<typeof TeamProposalDecisionSchema>;
