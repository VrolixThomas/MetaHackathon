import { z } from "zod";
import { RepositoryPathSchema } from "./common";
import { GitHubRepositorySchema, PreparedReviewSchema } from "./prepared-review";

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
	/** Server-derived attribution; the analysis is a reported local inference, not execution proof. */
	provenance: z.literal("reported-local-analysis").optional(),
	preparedBy: z.uuid().optional(),
});
export type TeamArtifact = z.infer<typeof ArtifactSchema>;
export const LocalReviewSubmissionSchema = z.strictObject({
	requestId: z.uuid(),
	key: ReviewKeySchema,
	review: PreparedReviewSchema,
	digest: Digest,
});
export type LocalReviewSubmission = z.infer<typeof LocalReviewSubmissionSchema>;
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

export const TeamScopeSchema = z.strictObject({
	orgId: z.uuid(),
	repositoryId: RepositoryId,
	repository: GitHubRepositorySchema,
	analysisVersion: z.string().min(1).max(160),
});
export type TeamScope = z.infer<typeof TeamScopeSchema>;
export const TeamStatusSchema = z.strictObject({
	configured: z.boolean(),
	connection: z.enum(["unconfigured", "disconnected", "connecting", "connected", "offline"]),
	userId: z.uuid().nullable(),
	scopes: z.array(TeamScopeSchema).max(100),
	canShare: z.boolean(),
	canApply: z.boolean(),
	error: z
		.enum([
			"configuration",
			"unauthorized",
			"forbidden",
			"offline",
			"conflict",
			"invalid",
			"unavailable",
		])
		.nullable(),
});
export const TeamOrganizationSchema = z.strictObject({
	id: z.uuid(),
	name: z.string().min(1).max(160),
});
export const TeamOrganizationsSchema = z.strictObject({
	analysisVersion: z.string().min(1).max(160),
	items: z.array(TeamOrganizationSchema).max(100),
});
export const TeamRepositorySchema = z.strictObject({
	orgId: z.uuid(),
	repositoryId: RepositoryId,
	fullName: GitHubRepositorySchema,
});
export const TeamRepositoriesSchema = z.strictObject({
	items: z.array(TeamRepositorySchema).max(10),
	nextOffset: z.int().nonnegative().nullable(),
});
export const CreateOrganizationSchema = z.strictObject({
	name: z.string().trim().min(1).max(160),
	requestId: z.uuid(),
});
export const RegisterRepositorySchema = z.strictObject({
	orgId: z.uuid(),
	repository: GitHubRepositorySchema,
	installationId: RepositoryId.optional(),
	requestId: z.uuid(),
});
export const SelectScopeSchema = z.strictObject({ orgId: z.uuid(), repositoryId: RepositoryId });
export const TeamDecisionSchema = z.strictObject({
	id: z.uuid(),
	proposalId: z.uuid(),
	bundleDigest: Digest,
	decision: z.enum(["accept", "decline"]),
	authorId: z.uuid(),
	githubAuthorId: RepositoryId,
	createdAt: z.iso.datetime(),
});
export const TeamProposalSummarySchema = z.strictObject({
	id: z.uuid(),
	key: ReviewKeySchema,
	ownerId: z.uuid(),
	bundleDigest: Digest,
	createdAt: z.iso.datetime(),
	decision: TeamDecisionSchema.nullable(),
});
export const TeamProposalDetailSchema = TeamProposalSummarySchema.extend({
	bundle: ProposalBundleSchema,
});
export const TeamProposalPageSchema = z.strictObject({
	items: z.array(TeamProposalSummarySchema).max(20),
	nextOffset: z.int().nonnegative().nullable(),
});
export const ProposalsInputSchema = z.strictObject({
	repository: GitHubRepositorySchema.optional(),
	prNumber: z.int().positive().optional(),
	offset: z.int().min(0).max(10000).default(0),
});
export const ReadProposalInputSchema = z.strictObject({
	proposalId: z.uuid(),
	repository: GitHubRepositorySchema.optional(),
});
export const ShareLocalProposalSchema = z.strictObject({
	candidateId: z.string().min(1).max(200),
	bundleDigest: Digest,
	repository: GitHubRepositorySchema.optional(),
	requestId: z.uuid(),
	confirmed: z.literal(true),
});
export const DecideTeamProposalSchema = ReadProposalInputSchema.extend({
	bundleDigest: Digest,
	decision: z.enum(["accept", "decline"]),
	requestId: z.uuid(),
	confirmed: z.literal(true),
});
export const ApplyTeamProposalSchema = ReadProposalInputSchema.extend({
	bundleDigest: Digest,
	requestId: z.uuid(),
	confirmed: z.literal(true),
});
export const TeamApplyReceiptSchema = z
	.strictObject({
		status: z.enum(["applied", "pending", "conflict", "unavailable"]),
		requestId: z.uuid(),
		proposalId: z.uuid(),
		bundleDigest: Digest,
		baseSha: Sha,
		candidateSha: Sha,
		appliedHeadSha: Sha.optional(),
		jobId: z.string().min(1).max(200).optional(),
		message: z.string().max(1000).optional(),
	})
	.refine(
		(value) => value.status !== "applied" || !!value.appliedHeadSha,
		"Applied receipts require an actual resulting head"
	);
export const TeamMutationResultSchema = z.strictObject({
	status: z.enum(["recorded", "pending"]),
	proposal: TeamProposalDetailSchema.nullable(),
	decision: TeamDecisionSchema.nullable(),
});
export type TeamStatus = z.infer<typeof TeamStatusSchema>;
export type TeamProposalDetail = z.infer<typeof TeamProposalDetailSchema>;
export type TeamProposalSummary = z.infer<typeof TeamProposalSummarySchema>;
export type TeamDecision = z.infer<typeof TeamDecisionSchema>;
export type TeamApplyReceipt = z.infer<typeof TeamApplyReceiptSchema>;

export const PreviewLocalProposalSchema = z.strictObject({
	candidateId: z.string().min(1).max(200),
	repository: GitHubRepositorySchema.optional(),
});
export const TeamLocalPreviewSchema = z.strictObject({
	candidateId: z.string().min(1).max(200),
	bundle: ProposalBundleSchema,
	bundleDigest: Digest,
});

export const ProgressConflictSchema = z.strictObject({
	requestId: z.uuid(),
	key: ReviewKeySchema,
	attempted: ProgressSchema,
	expectedRevision: z.int().nonnegative(),
	detectedAt: z.iso.datetime(),
	resolution: z.enum(["unresolved", "discarded", "replaced"]),
	replacementRequestId: z.uuid().optional(),
});
export const ProgressConflictListSchema = z.array(ProgressConflictSchema).max(200);
export const ResolveProgressConflictSchema = z
	.strictObject({
		requestId: z.uuid(),
		confirmed: z.literal(true),
		resolution: z.enum(["discard", "replace"]),
		replacement: ProgressWriteSchema.optional(),
	})
	.refine(
		(input) => (input.resolution === "replace" ? !!input.replacement : !input.replacement),
		"Replacement must be supplied only for explicit replace"
	);
export type ProgressConflict = z.infer<typeof ProgressConflictSchema>;

// Compatibility names from the integration bootstrap; all lanes share these exact wire schemas.
export {
	ReviewKeySchema as TeamReviewKeySchema,
	ArtifactSchema as TeamReviewArtifactSchema,
	ProgressSchema as TeamProgressSchema,
	ProposalBundleSchema as TeamProposalBundleSchema,
	ProposalDecisionSchema as TeamProposalDecisionSchema,
};
export type TeamReviewKey = ReviewKey;
export type TeamReviewArtifact = TeamArtifact;
export type TeamProposalBundle = ProposalBundle;
export type TeamProposalDecision = z.infer<typeof ProposalDecisionSchema>;
