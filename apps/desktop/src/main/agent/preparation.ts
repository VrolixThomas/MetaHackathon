import { z } from "zod";
import {
	CONTRACT_VERSION,
	EvidenceSchema,
	type ExecutionEvidence,
	ExecutionEvidenceSchema,
	type PRPreparation,
	PRPreparationSchema,
	type PullRequest,
	PullRequestSchema,
	RepositoryPathSchema,
	type WhyNote,
	WhyNoteSchema,
} from "../../shared/contracts";
import { abortable, throwIfAborted } from "./cancellation";

const changedFileSchema = z.strictObject({
	path: RepositoryPathSchema,
	baseContent: z.string().nullable(),
	headContent: z.string().nullable(),
	evidence: EvidenceSchema,
});
export const PreparationInputSchema = z.strictObject({
	pr: PullRequestSchema,
	files: z.array(changedFileSchema),
	evidence: EvidenceSchema,
	whyNotes: z.array(WhyNoteSchema).default([]),
});
export interface PreparationRuntime {
	/** Runtime chooses trusted build commands and executes them on pinned base/head worktrees. */
	runBuilds: (
		pr: PullRequest,
		signal: AbortSignal
	) => Promise<{ base: ExecutionEvidence; head: ExecutionEvidence }>;
}

/** Narrow checks avoid declaring arbitrary generated, lock or renamed code behavior-equivalent. */
function mechanicalCheck(file: z.infer<typeof changedFileSchema>): string | null {
	if (file.baseContent === null || file.headContent === null) return null;
	if (file.baseContent === file.headContent)
		return "Compared both file contents: byte-for-byte equal";
	if (file.path.endsWith(".json")) {
		try {
			JSON.parse(file.baseContent);
			JSON.parse(file.headContent);
			// Parsing alone loses duplicate members, number precision and negative zero.
			// Strip only whitespace outside strings so the original tokens must match.
			const tokens = (content: string) =>
				content.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (token) => (token.startsWith('"') ? token : ""));
			if (tokens(file.baseContent) === tokens(file.headContent)) {
				return "Validated both JSON files: identical tokens; only formatting whitespace differs";
			}
		} catch {
			return null;
		}
	}
	return null;
}
function role(path: string): {
	rank: number;
	attention: "read" | "skim" | "preview";
	reason: string;
} {
	if (/(^|\/)(pricing|payments?|auth|security|permissions?)(\/|\.)/i.test(path))
		return { rank: 0, attention: "read", reason: "Review policy, money or access rules first" };
	if (/(^|\/)(orders?|repositories|services?)(\/|\.)/i.test(path))
		return { rank: 1, attention: "read", reason: "Review persistence and service behavior" };
	if (/(^|\/)(migrations?)(\/|\.)/i.test(path) || path.endsWith(".sql"))
		return { rank: 2, attention: "skim", reason: "Review schema changes and rollout implications" };
	if (/\.(tsx|jsx|css|html)$/.test(path))
		return {
			rank: 3,
			attention: "preview",
			reason: "Review the visible states in a runtime preview",
		};
	return {
		rank: 4,
		attention: "read",
		reason: "Behavior change has not been mechanically established",
	};
}

export async function preparePullRequest(
	raw: unknown,
	runtime: PreparationRuntime,
	signal: AbortSignal
): Promise<PRPreparation> {
	throwIfAborted(signal);
	const input = PreparationInputSchema.parse(raw);
	if (new Set(input.files.map((file) => file.path)).size !== input.files.length)
		throw new Error("Duplicate changed file");
	const checks = new Map(input.files.map((file) => [file.path, mechanicalCheck(file)]));
	let builds: { base: ExecutionEvidence; head: ExecutionEvidence } | undefined;
	if ([...checks.values()].some(Boolean)) {
		try {
			const result = await abortable(runtime.runBuilds(structuredClone(input.pr), signal), signal);
			throwIfAborted(signal);
			builds = {
				base: ExecutionEvidenceSchema.parse(result.base),
				head: ExecutionEvidenceSchema.parse(result.head),
			};
			if (builds.base.commitSha !== input.pr.baseSha || builds.head.commitSha !== input.pr.headSha)
				throw new Error("Build results belong to other revisions");
		} catch {
			if (signal.aborted) throw new DOMException("Preparation cancelled", "AbortError");
			builds = undefined;
		}
	}
	throwIfAborted(signal);
	const successful = builds?.base.exitCode === 0 && builds.head.exitCode === 0;
	const files = [...input.files]
		.sort((a, b) => {
			const rank = (f: typeof a) =>
				checks.get(f.path) ? 6 : /(^|[/.])(test|spec)[/.]/.test(f.path) ? 5 : role(f.path).rank;
			return rank(a) - rank(b) || a.path.localeCompare(b.path);
		})
		.map((file, readingOrder) => {
			const check = checks.get(file.path);
			const reviewRole = role(file.path);
			const isTest = /(^|[/.])(test|spec)[/.]/.test(file.path);
			return {
				path: file.path,
				category: check
					? successful
						? ("mechanical-verified" as const)
						: ("mechanical-candidate" as const)
					: isTest
						? ("test" as const)
						: ("needs-review" as const),
				attention: check ? ("skim" as const) : reviewRole.attention,
				reason: check
					? `${check}. ${successful ? "Builds succeeded at the exact base and head SHAs. Build success does not establish behavior equivalence." : "Both builds have not been confirmed successful; reviewer attention still required."}`
					: reviewRole.reason,
				readingOrder,
				evidence: file.evidence,
				...(check && builds ? { behaviorCheck: builds } : {}),
			};
		});
	return PRPreparationSchema.parse({
		contractVersion: CONTRACT_VERSION,
		pr: input.pr,
		status: "ready",
		summary: `${files.filter((file) => file.category !== "mechanical-verified").length} of ${files.length} files need review. ${files.filter((file) => file.category === "mechanical-verified").length} passed the stated content comparison and both builds.`,
		files,
		whyNotes: input.whyNotes as WhyNote[],
		evidence: input.evidence,
	});
}
