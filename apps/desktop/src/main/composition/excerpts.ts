import {
	type CodeExcerpt,
	CodeExcerptSchema,
	type Evidence,
	MAX_CODE_EXCERPTS,
	MAX_CODE_EXCERPT_CHARS,
	type PullRequest,
} from "../../shared/contracts";

/** Bounded verbatim prefixes, not generated explanations or execution claims. */
export function sourceExcerpts(
	pr: PullRequest,
	files: { path: string; baseContent: string | null; headContent: string | null }[],
	evidence: (path: string, revision: "base" | "head") => Evidence
): CodeExcerpt[] {
	const result: CodeExcerpt[] = [];
	for (const file of files) {
		for (const revision of ["head", "base"] as const) {
			if (result.length >= MAX_CODE_EXCERPTS) return result;
			const content = revision === "head" ? file.headContent : file.baseContent;
			if (!content || content.includes("\0")) continue;
			const selected: string[] = [];
			let length = 0;
			for (const line of content.split("\n").slice(0, 120)) {
				const added = line.length + (selected.length ? 1 : 0);
				if (length + added > MAX_CODE_EXCERPT_CHARS) break;
				selected.push(line);
				length += added;
			}
			if (!selected.length) continue;
			result.push(
				CodeExcerptSchema.parse({
					location: {
						repository: pr.repository,
						revision,
						commitSha: revision === "head" ? pr.headSha : pr.baseSha,
						path: file.path,
						startLine: 1,
						endLine: selected.length,
					},
					text: selected.join("\n"),
					evidence: evidence(file.path, revision),
				})
			);
		}
	}
	return result;
}
