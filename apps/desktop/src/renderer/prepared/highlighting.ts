import { type HighlighterCore, createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import css from "shiki/langs/css.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsonc from "shiki/langs/jsonc.mjs";
import jsx from "shiki/langs/jsx.mjs";
import markdown from "shiki/langs/markdown.mjs";
import python from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import sql from "shiki/langs/sql.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import yaml from "shiki/langs/yaml.mjs";
import darkPlus from "shiki/themes/dark-plus.mjs";
import type { ReviewFile } from "../../shared/contracts";
import { type PatchLine, sourceLines } from "./diff";

export type SyntaxToken = { content: string; color?: string; fontStyle?: number };
export type HighlightedSource = {
	path: string;
	commitSha: string;
	language: string;
	lines: SyntaxToken[][];
};
export type HighlightedReview = {
	file: ReviewFile;
	base: HighlightedSource;
	head: HighlightedSource;
};
const languages = {
	typescript,
	tsx,
	javascript,
	jsx,
	json,
	jsonc,
	css,
	html,
	python,
	go,
	rust,
	shellscript,
	sql,
	yaml,
	markdown,
};
type Language = keyof typeof languages;
const extensions: Record<string, Language> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "jsx",
	json: "json",
	jsonc: "jsonc",
	css: "css",
	html: "html",
	htm: "html",
	py: "python",
	pyi: "python",
	go: "go",
	rs: "rust",
	sh: "shellscript",
	bash: "shellscript",
	zsh: "shellscript",
	sql: "sql",
	yaml: "yaml",
	yml: "yaml",
	md: "markdown",
	markdown: "markdown",
};
export function sourceLanguage(path: string): Language | "plaintext" {
	const name = path.split("/").at(-1)?.toLowerCase() ?? "";
	const extension = name.split(".").at(-1) ?? "";
	return Object.hasOwn(extensions, extension)
		? (extensions[extension] ?? "plaintext")
		: "plaintext";
}
let highlighter: Promise<HighlighterCore> | undefined;
function tokenizer() {
	// Explicit local grammar/theme imports and the JS engine keep CDN and WASM out of this path.
	highlighter ??= createHighlighterCore({
		themes: [darkPlus],
		langs: Object.values(languages),
		engine: createJavaScriptRegexEngine(),
	});
	return highlighter;
}
function plain(content: string): SyntaxToken[] {
	return content ? [{ content }] : [];
}
const textOf = (tokens: SyntaxToken[]) => tokens.map((token) => token.content).join("");
async function highlightSource(source: ReviewFile["base"]): Promise<HighlightedSource> {
	const rawLines = source.content === null ? [] : sourceLines(source.content);
	const language = sourceLanguage(source.path);
	const result = {
		path: source.path,
		commitSha: source.commitSha,
		language,
		lines: rawLines.map(plain),
	};
	if (source.status !== "available" || source.content === null || language === "plaintext")
		return result;
	try {
		// Each call starts from its own grammar state; never tokenize isolated patch hunks.
		const tokens = (await tokenizer()).codeToTokensBase(source.content, {
			lang: language,
			theme: "dark-plus",
		});
		return {
			...result,
			lines: rawLines.map((text, line) => {
				const values = (tokens[line] ?? []).map(({ content, color, fontStyle }) => ({
					content,
					color,
					fontStyle,
				}));
				const tokenText = textOf(values);
				if (tokenText === text) return values;
				// Shiki removes CR from CRLF line endings; the existing source row retains it.
				if (text.endsWith("\r") && tokenText === text.slice(0, -1))
					return [...values, { content: "\r" }];
				return plain(text);
			}),
		};
	} catch {
		return { ...result, language: "plaintext" };
	}
}
const cache = new WeakMap<ReviewFile, Promise<HighlightedReview>>();
export function highlightReviewFile(file: ReviewFile): Promise<HighlightedReview> {
	let result = cache.get(file);
	if (!result) {
		result = Promise.all([highlightSource(file.base), highlightSource(file.head)]).then(
			([base, head]) => ({ file, base, head })
		);
		cache.set(file, result);
	}
	return result;
}
/** Color only a line whose exact text and pinned side match the rendered source. */
export function sourceLineTokens(
	review: HighlightedReview | null,
	file: ReviewFile,
	side: "base" | "head",
	line: number,
	text: string
): SyntaxToken[] | undefined {
	if (
		!review ||
		review.file !== file ||
		review[side].path !== file[side].path ||
		review[side].commitSha !== file[side].commitSha
	)
		return;
	const tokens = review[side].lines[line - 1];
	return tokens && textOf(tokens) === text ? tokens : undefined;
}
export function patchLineTokens(
	review: HighlightedReview | null,
	file: ReviewFile,
	line: PatchLine
): SyntaxToken[] | undefined {
	if (line.kind === "meta" || !review || review.file !== file) return;
	const side = line.kind === "remove" ? "base" : "head";
	const number = line[side];
	if (number === undefined) return;
	const exact = sourceLineTokens(review, file, side, number, line.text);
	if (exact) return exact;
	// GitHub may normalize patch EOLs while the full pinned source still has CRLF.
	const crlf = sourceLineTokens(review, file, side, number, `${line.text}\r`);
	if (!crlf) return;
	const trimmed = crlf.map((token) => ({ ...token }));
	const last = trimmed.at(-1);
	if (last) last.content = last.content.slice(0, -1);
	return textOf(trimmed) === line.text ? trimmed : undefined;
}
