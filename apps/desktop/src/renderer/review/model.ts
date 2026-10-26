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

export type Artifact = "conversation" | "scenario" | "preview" | "diagram" | "signoff";

export function parseDiff(before: string, after: string): DiffLine[] {
	const old = before ? before.split("\n") : [];
	const next = after ? after.split("\n") : [];
	// Bound quadratic work. Large replacements retain correct source line identities.
	if (old.length * next.length > 2_000_000)
		return [
			...old.map(
				(text, index): DiffLine => ({
					id: `old-${index}`,
					kind: "remove",
					oldLine: index + 1,
					text,
				})
			),
			...next.map(
				(text, index): DiffLine => ({ id: `new-${index}`, kind: "add", newLine: index + 1, text })
			),
		];
	const lengths = Array.from({ length: old.length + 1 }, () => new Uint32Array(next.length + 1));
	for (let i = old.length - 1; i >= 0; i--) {
		for (let j = next.length - 1; j >= 0; j--) {
			const row = lengths[i];
			if (!row) continue;
			row[j] =
				old[i] === next[j]
					? (lengths[i + 1]?.[j + 1] ?? 0) + 1
					: Math.max(lengths[i + 1]?.[j] ?? 0, lengths[i]?.[j + 1] ?? 0);
		}
	}
	const lines: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < old.length || j < next.length) {
		const id = `${i}-${j}`;
		if (i < old.length && j < next.length && old[i] === next[j]) {
			lines.push({ id, kind: "context", oldLine: ++i, newLine: ++j, text: old[i - 1] ?? "" });
		} else if (
			i < old.length &&
			(j === next.length || (lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0))
		) {
			lines.push({ id, kind: "remove", oldLine: ++i, text: old[i - 1] ?? "" });
		} else {
			lines.push({ id, kind: "add", newLine: ++j, text: next[j - 1] ?? "" });
		}
	}
	return lines;
}
