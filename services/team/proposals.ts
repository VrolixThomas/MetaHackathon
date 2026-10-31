import { z } from "zod";
import { RepositoryPathSchema } from "../../apps/desktop/src/shared/contracts";
import { Digest, RepositoryId, ReviewKeySchema, Sha, digest, sha256 } from "./protocol";

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
export function validateBundle(raw: unknown): ProposalBundle {
	const bundle = ProposalBundleSchema.parse(raw);
	const blobs = [
		bundle.patch,
		...bundle.files.flatMap((file) => [file.before, file.after]),
		...bundle.checks.map((check) => check.output),
	];
	if (
		!bundle.patch.text ||
		blobs.some(
			(blob) =>
				blob &&
				(blob.text.includes("\0") || Buffer.from(blob.text, "utf8").toString("utf8") !== blob.text)
		)
	)
		throw new Error("Proposal requires exact UTF-8 text");
	if (
		Buffer.byteLength(JSON.stringify(bundle)) > 2000000 ||
		bundle.baseSha !== bundle.key.headSha ||
		bundle.candidateSha === bundle.baseSha ||
		new Set(bundle.files.map((file) => file.path)).size !== bundle.files.length ||
		digest(bundle.files) !== bundle.sourcesDigest ||
		digest(bundle.checks) !== bundle.checksDigest ||
		sha256(bundle.patch.text) !== bundle.patch.sha256 ||
		sha256(bundle.feedback.body) !== bundle.feedback.bodyDigest
	)
		throw new Error("Proposal content identity mismatch");
	for (const file of bundle.files) {
		if (
			(!file.before && !file.after) ||
			(file.before && sha256(file.before.text) !== file.before.sha256) ||
			(file.after && sha256(file.after.text) !== file.after.sha256) ||
			(file.before && file.after && file.before.text === file.after.text)
		)
			throw new Error("Proposal source mismatch");
	}
	for (const check of bundle.checks)
		if (
			check.commitSha !== bundle.candidateSha ||
			Date.parse(check.finishedAt) < Date.parse(check.startedAt) ||
			sha256(check.output.text) !== check.output.sha256
		)
			throw new Error("Proposal check identity mismatch");
	return bundle;
}
