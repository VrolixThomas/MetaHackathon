import { type ProposalBundle, ProposalBundleSchema, digest, sha256 } from "./protocol";
export {
	ProposalBundleSchema,
	type ProposalBundle,
	ShareProposalSchema,
	ProposalDecisionSchema,
} from "./schemas";
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
