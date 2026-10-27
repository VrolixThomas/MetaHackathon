import assert from "node:assert/strict";
import { test } from "node:test";
import type { PinnedReviewFileRequest } from "../../shared/contracts";
import type { CredentialAccess } from "./credentials";
import { GitHubClient } from "./github";
import { createRuntimeRouter } from "./router";
import type { RuntimeService } from "./service";

const credentials: CredentialAccess = {
	async get() {
		return "test-token";
	},
	async set() {},
	async delete() {},
	async status() {
		return [];
	},
};
const input: PinnedReviewFileRequest = {
	prId: "owner/repo#7",
	baseSha: "b".repeat(40),
	headSha: "a".repeat(40),
	path: "src/new name.ts",
};
const metadata = {
	number: 7,
	html_url: "https://github.com/owner/repo/pull/7",
	title: "Change",
	user: { login: "author" },
	base: { sha: input.baseSha, repo: { full_name: "owner/repo" } },
	head: { sha: input.headSha, repo: { full_name: "contributor/fork" } },
};
const changed = {
	filename: input.path,
	status: "modified",
	additions: 2,
	deletions: 1,
	patch: "@@ -1 +1 @@\n-old\n+new",
};
function contents(path: string, text: string | Buffer) {
	const bytes = typeof text === "string" ? Buffer.from(text) : text;
	return {
		path,
		type: "file",
		size: bytes.length,
		encoding: "base64",
		content: bytes.toString("base64"),
	};
}
function fixture(
	options: {
		changed?: object[];
		getPR?: (read: number) => object;
		source?: (url: URL) => Response;
		files?: (page: number) => object[];
	} = {}
) {
	const urls: URL[] = [];
	let prReads = 0;
	const client = new GitHubClient(credentials, (async (
		target: string | URL | Request,
		init?: RequestInit
	) => {
		const url = new URL(String(target));
		urls.push(url);
		assert.equal(url.origin, "https://api.github.com");
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "error");
		if (url.pathname.endsWith("/pulls/7"))
			return Response.json(options.getPR?.(++prReads) ?? metadata);
		if (url.pathname.endsWith("/files"))
			return Response.json(
				options.files?.(Number(url.searchParams.get("page"))) ?? options.changed ?? [changed]
			);
		assert.equal(new Headers(init?.headers).get("accept"), "application/vnd.github.object+json");
		return (
			options.source?.(url) ??
			Response.json(
				contents(
					decodeURIComponent(url.pathname.split("/contents/")[1] ?? ""),
					"\ufeff  text\n€ value\n"
				)
			)
		);
	}) as typeof fetch);
	return { client, urls };
}

test("review files read exact pinned base/head contents from the proper fork and preserve text", async () => {
	const f = fixture();
	const result = await f.client.reviewFile(input);
	assert.equal(result.base.content, "\ufeff  text\n€ value\n");
	assert.equal(result.head.content, result.base.content);
	assert.equal(result.base.commitSha, input.baseSha);
	assert.equal(result.head.commitSha, input.headSha);
	assert.equal(result.patch, changed.patch);
	const sources = f.urls.filter((url) => url.pathname.includes("/contents/"));
	assert.equal(sources[0]?.pathname, "/repos/owner/repo/contents/src/new%20name.ts");
	assert.equal(sources[0]?.searchParams.get("ref"), input.baseSha);
	assert.equal(sources[1]?.pathname, "/repos/contributor/fork/contents/src/new%20name.ts");
	assert.equal(sources[1]?.searchParams.get("ref"), input.headSha);
	assert.equal(f.urls.filter((url) => url.pathname.endsWith("/pulls/7")).length, 2);
});

test("renames read the original base path; additions/removals return only known missing sides", async () => {
	const renamed = fixture({
		changed: [{ ...changed, status: "renamed", previous_filename: "src/old.ts" }],
	});
	const result = await renamed.client.reviewFile(input);
	assert.equal(result.base.path, "src/old.ts");
	assert.equal(result.head.path, input.path);
	for (const status of ["added", "removed"] as const) {
		const f = fixture({ changed: [{ ...changed, status }] });
		const file = await f.client.reviewFile(input);
		const missing = status === "added" ? file.base : file.head;
		assert.equal(missing.status, "missing");
		assert.equal(missing.content, null);
		assert.equal(f.urls.filter((url) => url.pathname.includes("/contents/")).length, 1);
	}
	await assert.rejects(
		fixture({ changed: [{ ...changed, status: "renamed" }] }).client.reviewFile(input),
		/original path/
	);
});

test("binary, invalid UTF-8, oversized, empty and unavailable patches are represented honestly", async () => {
	for (const [body, status, content] of [
		[contents(input.path, Buffer.from([0, 1, 2])), "binary", null],
		[contents(input.path, Buffer.from([255, 254])), "binary", null],
		[
			{ path: input.path, type: "file", size: 300001, encoding: "none", content: "" },
			"too-large",
			null,
		],
		[contents(input.path, ""), "available", ""],
	] as const) {
		const result = await fixture({
			source: () => Response.json(body),
			changed: [{ ...changed, patch: "x".repeat(100001) }],
		}).client.reviewFile(input);
		assert.equal(result.base.status, status);
		assert.equal(result.base.content, content);
		assert.equal(result.patch, null);
	}
	const result = await fixture({ changed: [{ ...changed, patch: undefined }] }).client.reviewFile(
		input
	);
	assert.equal(result.patch, null);
});

test("review file rejects stale pins before contents and detects movement after reads", async () => {
	for (const side of ["base", "head"] as const) {
		const stale = { ...metadata, [side]: { ...metadata[side], sha: "c".repeat(40) } };
		const before = fixture({ getPR: () => stale });
		await assert.rejects(before.client.reviewFile(input), /revision changed/);
		assert.equal(before.urls.length, 1);
		const after = fixture({ getPR: (read) => (read === 1 ? metadata : stale) });
		await assert.rejects(after.client.reviewFile(input), /revision changed/);
	}
});

test("review file must be a changed path, paginates files and never follows provider download URLs", async () => {
	const absent = fixture({ changed: [] });
	await assert.rejects(absent.client.reviewFile(input), /changed-file list/);
	assert.equal(absent.urls.length, 2);
	const paged = fixture({
		files: (page) =>
			page === 1
				? Array.from({ length: 100 }, (_, i) => ({ ...changed, filename: `other/${i}` }))
				: [changed],
		source: () =>
			Response.json({
				...contents(input.path, "text"),
				download_url: "https://untrusted.invalid/secret",
			}),
	});
	await paged.client.reviewFile(input);
	assert.equal(paged.urls.filter((url) => url.pathname.endsWith("/files")).length, 2);
	await assert.rejects(fixture().client.reviewFile({ ...input, path: "../secret" }));
	await assert.rejects(
		fixture({ source: () => new Response("private body", { status: 404 }) }).client.reviewFile(
			input
		),
		/inaccessible/
	);
});

test("malformed, non-file and oversized source responses fail without claiming text", async () => {
	for (const body of [
		{ ...contents(input.path, "ok"), size: 999 },
		{ ...contents(input.path, "ok"), content: "!!" },
		{ ...contents(input.path, "ok"), path: "other" },
		{ path: input.path, type: "symlink", size: 2 },
		[],
	])
		await assert.rejects(fixture({ source: () => Response.json(body) }).client.reviewFile(input));
	await assert.rejects(
		fixture({
			source: () =>
				Response.json({ ...contents(input.path, "text"), padding: "x".repeat(2_000_001) }),
		}).client.reviewFile(input),
		/bounded read limit/
	);
});

test("reviewFile router validates pinned input and preserves the source statuses", async () => {
	const f = fixture();
	const runtime = {
		reviewFile: (request: PinnedReviewFileRequest) => f.client.reviewFile(request),
	} as RuntimeService;
	const caller = createRuntimeRouter(() => runtime).createCaller({});
	assert.equal((await caller.reviewFile(input)).base.status, "available");
	await assert.rejects(caller.reviewFile({ ...input, headSha: "branch-name" }));
});

test("trusted local source port avoids remote contents and only undefined falls back", async () => {
	const f = fixture();
	const result = await f.client.reviewFile(
		input,
		undefined,
		async (_repository, path, commitSha) => ({
			path,
			commitSha,
			status: "available",
			content: "local pinned source",
		})
	);
	assert.equal(result.base.content, "local pinned source");
	assert.equal(f.urls.filter((url) => url.pathname.includes("/contents/")).length, 0);
	const fallback = fixture();
	await fallback.client.reviewFile(input, undefined, async () => undefined);
	assert.equal(fallback.urls.filter((url) => url.pathname.includes("/contents/")).length, 2);
	const failed = fixture();
	await assert.rejects(
		failed.client.reviewFile(input, undefined, async () => {
			throw Error("Local origin changed");
		}),
		/Local origin changed/
	);
	assert.equal(failed.urls.filter((url) => url.pathname.includes("/contents/")).length, 0);
});
