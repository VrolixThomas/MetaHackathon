import { z } from "zod";
import { GitHubRepositorySchema } from "../../apps/desktop/src/shared/contracts";
import { Digest, ProposalBundleSchema, RepositoryId, ReviewKeySchema, Sha } from "./schemas";

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
