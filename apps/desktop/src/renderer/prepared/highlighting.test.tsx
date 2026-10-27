import assert from "node:assert/strict";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewFile } from "../../shared/contracts";
import { SyntaxText } from "./ReviewWorkspace";
import { patchLines, sourceLines } from "./diff";
import {
	highlightReviewFile,
	patchLineTokens,
	sourceLanguage,
	sourceLineTokens,
} from "./highlighting";

function file(base: string, head = base, path = "src/example.ts"): ReviewFile {
	return {
		prId: "owner/repo#1",
		path,
		status: "modified",
		patch: null,
		base: { path, commitSha: "a".repeat(40), status: "available", content: base },
		head: { path, commitSha: "b".repeat(40), status: "available", content: head },
	};
}
it("colors full pinned revisions independently and maps diff lines with off-hunk multiline context", async () => {
	const input = file(
		'/* old comment starts outside the hunk\nconst same = "comment";\n',
		'// head is ordinary code\nconst same = "value";\n'
	);
	input.patch = '@@ -2 +2 @@\n-const same = "comment";\n+const same = "value";';
	const highlighted = await highlightReviewFile(input);
	const rows = patchLines(input.patch);
	const removal = rows[1];
	const addition = rows[2];
	assert.ok(removal);
	assert.ok(addition);
	const before = patchLineTokens(highlighted, input, removal);
	const after = patchLineTokens(highlighted, input, addition);
	assert.equal(before, highlighted.base.lines[1]);
	assert.equal(after, highlighted.head.lines[1]);
	assert.equal(before?.map((token) => token.content).join(""), removal.text);
	assert.equal(after?.map((token) => token.content).join(""), addition.text);
	assert.ok(before?.[0]?.color);
	assert.ok(after?.[0]?.color);
	assert.notEqual(
		before?.[0]?.color,
		after?.[0]?.color,
		"The head must not inherit the base's open comment"
	);
	assert.ok(new Set(after?.map((token) => token.color)).size >= 3);
	const header = rows[0];
	assert.ok(header);
	assert.equal(patchLineTokens(highlighted, input, header), undefined);
});
it("retains tabs, Unicode, CRLF and final blank lines exactly", async () => {
	for (const code of [
		'\tconst café = "<&>";\r\n\r\n',
		"\n",
		"",
		"const x = 1;",
		"/* x\r\n y */\r\n",
	]) {
		const input = file(code);
		const result = await highlightReviewFile(input);
		const lines = result.head.lines.map((tokens) => tokens.map((token) => token.content).join(""));
		assert.deepEqual(lines, sourceLines(code));
		assert.equal(lines.join("\n") + (code.endsWith("\n") ? "\n" : ""), code);
		for (const [index, line] of lines.entries())
			assert.ok(sourceLineTokens(result, input, "head", index + 1, line));
	}
	const input = file("const x = 1;\r\n");
	const result = await highlightReviewFile(input);
	const row = { kind: "add" as const, head: 1, text: "const x = 1;" };
	assert.equal(
		patchLineTokens(result, input, row)
			?.map((token) => token.content)
			.join(""),
		row.text
	);
});
it("uses each renamed side's language and rejects tokens for a different file or mismatched patch text", async () => {
	const input = file("const n = 1;\n", "n = 'value'\n", "new/example.py");
	input.status = "renamed";
	input.base.path = "old/example.ts";
	const result = await highlightReviewFile(input);
	assert.equal(result.base.language, "typescript");
	assert.equal(result.head.language, "python");
	assert.equal(
		sourceLineTokens(result, structuredClone(input), "head", 1, "n = 'value'"),
		undefined
	);
	assert.equal(
		patchLineTokens(result, input, { kind: "add", head: 1, text: "wrong source" }),
		undefined
	);
});
it("loads only bundled common languages with safe plain fallback for unsupported or unavailable source", async () => {
	const samples = [
		["a.tsx", "const view = <Button value={1} />;"],
		["a.jsx", "const view = <span>text</span>;"],
		["a.js", "const n = 'value';"],
		["a.json", '{"value": 1}'],
		["a.jsonc", '// note\n{"value": 1}'],
		["a.css", ".card { color: red; }"],
		["a.html", '<div class="card">text</div>'],
		["a.py", 'def f():\n    return "value"'],
		["a.go", 'package main\nfunc main() { println("hi") }'],
		["a.rs", 'fn main() { let x = "hi"; }'],
		["a.sh", 'echo "$HOME"'],
		["a.sql", "SELECT name FROM users WHERE id = 1;"],
		["a.yaml", "name: value\nenabled: true"],
		["a.md", "# Heading\n**bold** and `code`"],
	];
	for (const [path, code] of samples) {
		assert.ok(path);
		assert.ok(code);
		const result = await highlightReviewFile(file(code, code, path));
		assert.notEqual(result.head.language, "plaintext", path);
		assert.ok(
			result.head.lines.flat().some((token) => token.color),
			path
		);
	}
	for (const path of ["file.unknown", "constructor", "__proto__"]) {
		assert.equal(sourceLanguage(path), "plaintext");
		const result = await highlightReviewFile(file("<unknown>\ttext\n", undefined, path));
		assert.equal(
			result.head.lines.flat().some((token) => token.color),
			false
		);
	}
	const missing = file("", "");
	missing.base = { ...missing.base, status: "missing", content: null };
	assert.deepEqual((await highlightReviewFile(missing)).base.lines, []);
});
it("renders syntax as escaped React text without changing source content", async () => {
	const code = 'const markup = "<img src=x onerror=alert(1)>";';
	const input = file(code);
	const result = await highlightReviewFile(input);
	const tokens = sourceLineTokens(result, input, "head", 1, code);
	const html = renderToStaticMarkup(
		<code>
			<SyntaxText text={code} tokens={tokens} />
		</code>
	);
	assert.match(html, /class="syntax-token"/);
	assert.match(html, /style="color:/);
	assert.match(html, /&lt;img/);
	assert.doesNotMatch(html, /<img|<script/);
	assert.equal(tokens?.map((token) => token.content).join(""), code);
});
it("bundles explicit local grammars and the JS engine without an all-language bundle or WASM", async () => {
	const result = await build({
		entryPoints: [fileURLToPath(new URL("./highlighting.ts", import.meta.url))],
		bundle: true,
		platform: "browser",
		write: false,
		metafile: true,
		logLevel: "silent",
	});
	const inputs = Object.keys(result.metafile.inputs);
	assert.ok(inputs.some((path) => path.includes("engine-javascript")));
	assert.equal(
		inputs.some((path) =>
			/engine-oniguruma|\.wasm$|\/wasm\.mjs$|bundle-full|\/langs\.mjs$/.test(path)
		),
		false
	);
	assert.equal(
		Object.values(result.metafile.outputs).some((output) =>
			output.imports.some((entry) => entry.external)
		),
		false
	);
});
