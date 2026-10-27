export type PatchLine = {
	kind: "context" | "add" | "remove" | "meta";
	text: string;
	base?: number;
	head?: number;
};
/** GitHub's supplied patch, preserving source text and one-based line numbers. */
export function patchLines(patch: string): PatchLine[] {
	let base = 0;
	let head = 0;
	let inHunk = false;
	return patch.split("\n").map((line) => {
		const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunk) {
			base = Number(hunk[1]);
			head = Number(hunk[2]);
			inHunk = true;
			return { kind: "meta", text: line };
		}
		if (inHunk && line.startsWith("+")) return { kind: "add", text: line.slice(1), head: head++ };
		if (inHunk && line.startsWith("-"))
			return { kind: "remove", text: line.slice(1), base: base++ };
		if (inHunk && line.startsWith(" "))
			return { kind: "context", text: line.slice(1), base: base++, head: head++ };
		return { kind: "meta", text: line };
	});
}
export function sourceLines(text: string): string[] {
	return text ? text.replace(/\n$/, "").split("\n") : [];
}
