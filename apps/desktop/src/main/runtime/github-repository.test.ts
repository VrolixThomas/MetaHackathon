import assert from "node:assert/strict";
import { test } from "node:test";
import type { CredentialAccess } from "./credentials";
import { GitHubClient } from "./github";
import { createRuntimeRouter } from "./router";
import type { RuntimeService } from "./service";

const credentials: CredentialAccess = {
	async get() {
		return "fake-token";
	},
	async set() {},
	async delete() {},
	async status() {
		return [];
	},
};
function remote(number: number) {
	return {
		number,
		state: "open",
		html_url: `https://github.com/owner/repo/pull/${number}`,
		title: `Change ${number}`,
		user: { login: "author" },
		base: { sha: "b".repeat(40), repo: { full_name: "owner/repo" } },
		head: { sha: "a".repeat(40), repo: { full_name: "contributor/fork" } },
	};
}
function client(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
	return new GitHubClient(credentials, (async (
		input: string | URL | Request,
		init?: RequestInit
	) => {
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "error");
		const url = new URL(String(input));
		assert.equal(url.origin, "https://api.github.com");
		return handler(url, init);
	}) as typeof fetch);
}

test("repository PR listing is two bounded open pages with actual fork head/base metadata", async () => {
	const paths: string[] = [];
	const github = client((url) => {
		paths.push(url.pathname + url.search);
		const page = Number(url.searchParams.get("page"));
		return Response.json(Array.from({ length: 100 }, (_, i) => remote((page - 1) * 100 + i + 1)));
	});
	const prs = await github.openPullRequests("owner/repo");
	assert.equal(prs.length, 200);
	assert.equal(paths.length, 2);
	assert.ok(
		paths.every((path) => path.startsWith("/repos/owner/repo/pulls?state=open&per_page=100&"))
	);
	assert.equal(prs[0]?.repository, "owner/repo");
	assert.equal(prs[0]?.headSha, "a".repeat(40));
	assert.equal(prs[0]?.baseSha, "b".repeat(40));
});

test("repository PR listing handles empty repositories, deleted forks and page overlap", async () => {
	assert.deepEqual(await client(() => Response.json([])).openPullRequests("owner/repo"), []);
	let pages = 0;
	const prs = await client(() =>
		Response.json(
			++pages === 1
				? Array.from({ length: 100 }, (_, i) => remote(i + 1))
				: [remote(100), { ...remote(101), head: { sha: "c".repeat(40), repo: null } }]
		)
	).openPullRequests("owner/repo");
	assert.equal(prs.length, 101);
	assert.equal(prs[100]?.headSha, "c".repeat(40));
});

test("repository listing rejects invalid selectors and unrelated/closed remote PRs", async () => {
	let calls = 0;
	const github = client(() => {
		calls++;
		return Response.json([]);
	});
	for (const repository of [
		"owner",
		"../repo",
		"owner/..",
		"owner/repo?state=all",
		"https://github.com/owner/repo",
		"owner/repo/extra",
		"owner/repo\n",
	])
		await assert.rejects(github.openPullRequests(repository));
	assert.equal(calls, 0);
	await assert.rejects(
		client(() => Response.json([{ ...remote(1), state: "closed" }])).openPullRequests("owner/repo")
	);
	await assert.rejects(
		client(() =>
			Response.json([
				{ ...remote(1), base: { sha: "b".repeat(40), repo: { full_name: "other/repo" } } },
			])
		).openPullRequests("owner/repo"),
		/another repository/
	);
});

test("repository listing keeps auth errors sanitized and cancellation prevents another page", async () => {
	await assert.rejects(
		client(() => new Response("secret-response-body", { status: 401 })).openPullRequests(
			"owner/repo"
		),
		(error: Error) =>
			error.message.includes("gh auth login") && !error.message.includes("secret-response-body")
	);
	const controller = new AbortController();
	let calls = 0;
	const github = client(() => {
		calls++;
		controller.abort();
		return Response.json(Array.from({ length: 100 }, (_, i) => remote(i + 1)));
	});
	await assert.rejects(github.openPullRequests("owner/repo", controller.signal), /cancelled/);
	assert.equal(calls, 1);
});

test("repositoryPullRequests router validates the selector and returns the actual client list", async () => {
	const github = client(() => Response.json([remote(3)]));
	const runtime = {
		repositoryPullRequests: (repository: string) => github.openPullRequests(repository),
	} as RuntimeService;
	const caller = createRuntimeRouter(() => runtime).createCaller({});
	assert.equal(
		(await caller.repositoryPullRequests({ repository: "owner/repo" }))[0]?.id,
		"owner/repo#3"
	);
	await assert.rejects(caller.repositoryPullRequests({ repository: "../repo" }));
});
