import assert from "node:assert/strict";
import { it } from "node:test";
import { patchLines, sourceLines } from "./diff";
it("preserves patch whitespace and maps base/head lines through multiple hunks", () => {
	const rows = patchLines(
		"@@ -4,2 +4,3 @@\n keep\n-old\n+  new\n+++code\n@@ -10 +11 @@\n-last\n+next\n\\ No newline at end of file"
	);
	assert.deepEqual(rows[1], { kind: "context", text: "keep", base: 4, head: 4 });
	assert.deepEqual(rows[2], { kind: "remove", text: "old", base: 5 });
	assert.deepEqual(rows[3], { kind: "add", text: "  new", head: 5 });
	assert.deepEqual(rows[4], { kind: "add", text: "++code", head: 6 });
	assert.deepEqual(rows[7], { kind: "add", text: "next", head: 11 });
	assert.equal(rows[8]?.kind, "meta");
	assert.deepEqual(sourceLines("\tfirst\n\n"), ["\tfirst", ""]);
	assert.deepEqual(sourceLines(""), []);
});
