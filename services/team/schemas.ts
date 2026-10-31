import { z } from "zod";
import {
	PreparedReviewSchema,
	RepositoryPathSchema,
} from "../../apps/desktop/src/shared/contracts";
export const Digest = z.string().regex(/^[0-9a-f]{64}$/);
export const Sha = z.string().regex(/^[0-9a-f]{40}$/);
export const RepositoryId = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const ReviewKeySchema = z.strictObject({
	orgId: z.uuid(),
	repositoryId: RepositoryId,
	prNumber: z.int().positive(),
	baseSha: Sha,
	headSha: Sha,
	contextDigest: Digest,
	analysisVersion: z
		.string()
		.min(1)
		.max(160)
		.regex(/^[a-zA-Z0-9._:-]+$/),
});
export type ReviewKey = z.infer<typeof ReviewKeySchema>;
export const ArtifactSchema = z.strictObject({
	key: ReviewKeySchema,
	review: PreparedReviewSchema,
	digest: Digest,
});
export type TeamArtifact = z.infer<typeof ArtifactSchema>;
export const ProgressSchema = z.strictObject({
	key: ReviewKeySchema,
	cursor: RepositoryPathSchema.nullable(),
	visited: z.array(RepositoryPathSchema).max(100),
	notes: z.string().max(32000),
	paused: z.boolean(),
	revision: z.int().nonnegative(),
});
export type TeamProgress = z.infer<typeof ProgressSchema>;
export const ProgressWriteSchema = z.strictObject({
	requestId: z.uuid(),
	expectedRevision: z.int().nonnegative(),
	progress: ProgressSchema,
});
export const SessionSchema = z.object({
	access_token: z.string().min(1).max(32768),
	refresh_token: z.string().min(1).max(32768),
	expires_at: z.int().positive(),
	user: z.object({ id: z.uuid() }),
});
export type TeamSession = z.infer<typeof SessionSchema>;
const BlobSchema = z.strictObject({ text: z.string().max(300000), sha256: Digest });
export const ProposalBundleSchema = z.strictObject({
	key: ReviewKeySchema,
	feedback: z.strictObject({
		kind: z.enum(["pull-review-comment", "issue-comment"]),
		id: RepositoryId,
		revision: z.iso.datetime(),
		body: z.string().min(1).max(16000),
		bodyDigest: Digest,
	}),
	baseSha: Sha,
	candidateSha: Sha,
	files: z
		.array(
			z.strictObject({
				path: RepositoryPathSchema,
				before: BlobSchema.nullable(),
				after: BlobSchema.nullable(),
			})
		)
		.min(1)
		.max(40),
	patch: BlobSchema,
	checks: z
		.array(
			z.strictObject({
				command: z.array(z.string().min(1).max(2000)).min(1).max(30),
				cwd: RepositoryPathSchema.optional(),
				commitSha: Sha,
				startedAt: z.iso.datetime(),
				finishedAt: z.iso.datetime(),
				exitCode: z.int(),
				environment: z.string().min(1).max(4000),
				output: BlobSchema,
			})
		)
		.max(30),
	checksDigest: Digest,
	sourcesDigest: Digest,
	provenance: z.literal("reported-local-candidate"),
});
export type ProposalBundle = z.infer<typeof ProposalBundleSchema>;
export const ShareProposalSchema = z.strictObject({
	requestId: z.uuid(),
	bundle: ProposalBundleSchema,
	bundleDigest: Digest,
});
export const ProposalDecisionSchema = z.strictObject({
	key: ReviewKeySchema,
	proposalId: z.uuid(),
	bundleDigest: Digest,
	requestId: z.uuid(),
	decision: z.enum(["accept", "decline"]),
	confirmed: z.literal(true),
});
