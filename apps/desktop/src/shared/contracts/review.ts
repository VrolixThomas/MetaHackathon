import { z } from "zod";
import {
	CONTRACT_VERSION,
	CodeLocationSchema,
	CommitShaSchema,
	EvidenceSchema,
	ExecutionEvidenceSchema,
	IdSchema,
	RepositoryPathSchema,
	SourceReferenceSchema,
} from "./common";

export const PullRequestSchema = z.strictObject({
	id: IdSchema,
	repository: IdSchema,
	number: z.int().positive(),
	url: z.url(),
	title: z.string().min(1),
	author: IdSchema,
	baseSha: CommitShaSchema,
	headSha: CommitShaSchema,
});

export const FileTriageSchema = z
	.strictObject({
		path: RepositoryPathSchema,
		category: z.enum(["needs-review", "mechanical-candidate", "mechanical-verified", "test"]),
		attention: z.enum(["read", "skim", "preview", "decide"]),
		reason: z.string().min(1),
		readingOrder: z.int().nonnegative(),
		evidence: EvidenceSchema,
		behaviorCheck: z
			.strictObject({
				base: ExecutionEvidenceSchema,
				head: ExecutionEvidenceSchema,
			})
			.optional(),
	})
	.refine(
		(file) =>
			file.category !== "mechanical-verified" ||
			(file.behaviorCheck?.base.exitCode === 0 && file.behaviorCheck.head.exitCode === 0),
		"Verified mechanical files require successful runs on both revisions"
	);

export const WhyNoteSchema = z.strictObject({
	id: IdSchema,
	location: CodeLocationSchema,
	text: z.string().min(1),
	evidence: EvidenceSchema,
	provenance: z.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("recorded"),
			sources: z
				.array(SourceReferenceSchema)
				.min(1)
				.refine(
					(sources) => sources.some((source) => source.kind !== "code"),
					"Recorded intent requires a ticket, author session or PR source"
				),
		}),
		z.strictObject({
			kind: z.literal("inferred"),
			explanation: z.string().min(1),
			sources: z.array(SourceReferenceSchema),
		}),
	]),
});

export const PRPreparationSchema = z
	.strictObject({
		contractVersion: z.literal(CONTRACT_VERSION),
		pr: PullRequestSchema,
		status: z.enum(["queued", "preparing", "ready", "failed"]),
		summary: z.string(),
		files: z.array(FileTriageSchema),
		whyNotes: z.array(WhyNoteSchema),
		evidence: EvidenceSchema,
	})
	.superRefine((prep, ctx) => {
		if (
			new Set(prep.files.map((file) => file.path)).size !== prep.files.length ||
			new Set(prep.files.map((file) => file.readingOrder)).size !== prep.files.length
		) {
			ctx.addIssue({ code: "custom", message: "File paths and reading order must be unique" });
		}
		for (const file of prep.files) {
			if (
				file.behaviorCheck &&
				(file.behaviorCheck.base.commitSha !== prep.pr.baseSha ||
					file.behaviorCheck.head.commitSha !== prep.pr.headSha)
			) {
				ctx.addIssue({
					code: "custom",
					message: "Behavior checks must match PR base/head commits",
				});
			}
		}
		for (const note of prep.whyNotes) {
			const sha = note.location.revision === "base" ? prep.pr.baseSha : prep.pr.headSha;
			if (
				note.location.repository !== prep.pr.repository ||
				note.location.commitSha !== sha ||
				!prep.files.some((file) => file.path === note.location.path)
			) {
				ctx.addIssue({
					code: "custom",
					message: "Why note must reference a file at this PR revision",
				});
			}
		}
	});

export const DraftedCommentSchema = z.strictObject({
	id: IdSchema,
	prId: IdSchema,
	revision: z.int().positive(),
	headSha: CommitShaSchema,
	originalWords: z.string().min(1),
	body: z.string().min(1),
	location: CodeLocationSchema.optional(),
	evidence: EvidenceSchema,
});

// Main compares every field with the current draft/head before any GitHub write.
export const ConfirmCommentInputSchema = z.strictObject({
	requestId: IdSchema,
	draftId: IdSchema,
	draftRevision: z.int().positive(),
	headSha: CommitShaSchema,
	body: z.string().min(1),
	confirmed: z.literal(true),
});

export type PullRequest = z.infer<typeof PullRequestSchema>;
export type FileTriage = z.infer<typeof FileTriageSchema>;
export type WhyNote = z.infer<typeof WhyNoteSchema>;
export type PRPreparation = z.infer<typeof PRPreparationSchema>;
export type DraftedComment = z.infer<typeof DraftedCommentSchema>;
export type ConfirmCommentInput = z.infer<typeof ConfirmCommentInputSchema>;
