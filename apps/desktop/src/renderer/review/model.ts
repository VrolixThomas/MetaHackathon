/** Presentation data only. Shared evidence is adapted at the renderer boundary. */
export type DiffLine = {
	id: string;
	oldLine?: number;
	newLine?: number;
	kind: "context" | "add" | "remove";
	text: string;
};

export type ReviewFile = {
	path: string;
	purpose: string;
	attention: "read" | "skim" | "preview" | "decide" | "context" | "mechanical";
	additions: number;
	deletions: number;
	lines: DiffLine[];
	sourceAvailable?: boolean;
	sourceError?: string;
};

export type WhyNote = {
	id: string;
	file: string;
	start: number;
	end: number;
	title: string;
	body: string;
	provenance: "recorded" | "inferred";
	attention?: boolean;
};

export type CodeSelection = {
	file: string;
	start: number;
	end: number;
	side?: "before" | "after";
	note: string;
};

export type Artifact =
	| "browser"
	| "code"
	| "conversation"
	| "scenario"
	| "preview"
	| "diagram"
	| "signoff";

export function parseDiff(before: string, after: string): DiffLine[] {
	const allOld = before ? before.split("\n") : [];
	const allNext = after ? after.split("\n") : [];
	let prefix = 0;
	while (prefix < allOld.length && prefix < allNext.length && allOld[prefix] === allNext[prefix])
		prefix++;
	let suffix = 0;
	while (
		suffix < allOld.length - prefix &&
		suffix < allNext.length - prefix &&
		allOld[allOld.length - suffix - 1] === allNext[allNext.length - suffix - 1]
	)
		suffix++;
	const prefixLines = allOld.slice(0, prefix).map(
		(text, index): DiffLine => ({
			id: `prefix-${index}`,
			kind: "context",
			oldLine: index + 1,
			newLine: index + 1,
			text,
		})
	);
	const suffixLines = allOld.slice(allOld.length - suffix).map(
		(text, index): DiffLine => ({
			id: `suffix-${index}`,
			kind: "context",
			oldLine: allOld.length - suffix + index + 1,
			newLine: allNext.length - suffix + index + 1,
			text,
		})
	);
	const old = allOld.slice(prefix, allOld.length - suffix);
	const next = allNext.slice(prefix, allNext.length - suffix);
	// Bound quadratic work only for the changed region; retain unchanged prefix/suffix.
	if (old.length * next.length > 2_000_000)
		return [
			...prefixLines,
			...old.map(
				(text, index): DiffLine => ({
					id: `coarse-old-${index}`,
					kind: "remove",
					oldLine: prefix + index + 1,
					text,
				})
			),
			...next.map(
				(text, index): DiffLine => ({
					id: `coarse-new-${index}`,
					kind: "add",
					newLine: prefix + index + 1,
					text,
				})
			),
			...suffixLines,
		];
	const lengths = Array.from({ length: old.length + 1 }, () => new Uint32Array(next.length + 1));
	for (let i = old.length - 1; i >= 0; i--)
		for (let j = next.length - 1; j >= 0; j--) {
			const row = lengths[i];
			if (!row) continue;
			row[j] =
				old[i] === next[j]
					? (lengths[i + 1]?.[j + 1] ?? 0) + 1
					: Math.max(lengths[i + 1]?.[j] ?? 0, lengths[i]?.[j + 1] ?? 0);
		}
	const lines: DiffLine[] = [...prefixLines];
	let i = 0;
	let j = 0;
	while (i < old.length || j < next.length) {
		const id = `change-${i}-${j}`;
		if (i < old.length && j < next.length && old[i] === next[j]) {
			lines.push({
				id,
				kind: "context",
				oldLine: prefix + ++i,
				newLine: prefix + ++j,
				text: old[i - 1] ?? "",
			});
		} else if (
			i < old.length &&
			(j === next.length || (lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0))
		) {
			lines.push({ id, kind: "remove", oldLine: prefix + ++i, text: old[i - 1] ?? "" });
		} else {
			lines.push({ id, kind: "add", newLine: prefix + ++j, text: next[j - 1] ?? "" });
		}
	}
	return [...lines, ...suffixLines];
}
