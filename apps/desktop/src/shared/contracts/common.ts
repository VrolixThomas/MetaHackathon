import { z } from "zod";

export const CONTRACT_VERSION = 1;
export const IdSchema = z.string().trim().min(1);
export const CommitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const RevisionSchema = z.enum(["base", "head"]);
export const RepositoryPathSchema = z
	.string()
	.min(1)
	.refine(
		(path) =>
			!path.includes("\\") &&
			!path.includes("\0") &&
			path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
		"Expected a repository-relative POSIX path without traversal"
	);

export const CodeLocationSchema = z
	.strictObject({
		repository: IdSchema,
		revision: RevisionSchema,
		commitSha: CommitShaSchema,
		path: RepositoryPathSchema,
		startLine: z.int().positive(),
		endLine: z.int().positive(),
	})
	.refine((value) => value.endLine >= value.startLine, "Line range must be ordered");

export const FixtureEvidenceSchema = z.strictObject({
	kind: z.literal("fixture"),
	fixtureId: IdSchema,
	label: z.string().min(1),
});

export const ExecutionEvidenceSchema = z
	.strictObject({
		kind: z.literal("execution"),
		runId: IdSchema,
		commitSha: CommitShaSchema,
		command: z.array(z.string().min(1)).min(1),
		startedAt: z.iso.datetime(),
		completedAt: z.iso.datetime(),
		exitCode: z.int(),
		logUrl: z.url(),
	})
	.refine(
		(value) => Date.parse(value.completedAt) >= Date.parse(value.startedAt),
		"Execution completion must follow its start"
	);

export const EvidenceSchema = z.discriminatedUnion("kind", [
	FixtureEvidenceSchema,
	z.strictObject({ kind: z.literal("source"), url: z.url(), retrievedAt: z.iso.datetime() }),
	ExecutionEvidenceSchema,
]);
export const RunEvidenceSchema = z.discriminatedUnion("kind", [
	FixtureEvidenceSchema,
	ExecutionEvidenceSchema,
]);
export const SourceReferenceSchema = z.strictObject({
	kind: z.enum(["ticket", "author-session", "pr-description", "pr-comment", "code"]),
	url: z.url(),
	excerpt: z.string().min(1),
	evidence: EvidenceSchema,
});
export const JsonValuesSchema = z.record(z.string(), z.json());

export type CodeLocation = z.infer<typeof CodeLocationSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type ExecutionEvidence = z.infer<typeof ExecutionEvidenceSchema>;
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
