// Test-only fixtures/protocols. Requiring this module creates no repo, server or app.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const repository = "test-owner/pr-work-case";
const prId = `${repository}#7`;
const prURL = `https://github.com/${repository}/pull/7`;
const apiRoot = `https://api.github.com/repos/${repository}`;
const modelURL = "https://api.meta.ai/v1/responses";
const order = ["z-contract.ts", "a-logic.ts", "m-tests.ts"];
const base = {
	"z-contract.ts": "export type Quote = { subtotal: number };\n",
	"a-logic.ts":
		"import type { Quote } from './z-contract';\nexport const total = (quote: Quote) => quote.subtotal;\n",
	"m-tests.ts":
		"import { total } from './a-logic';\nexport const expected = total({ subtotal: 100 }) === 100;\n",
};
const head = {
	"z-contract.ts": "export type Quote = { subtotal: number; discount: number };\n",
	"a-logic.ts":
		"import type { Quote } from './z-contract';\nexport const total = (quote: Quote) => quote.subtotal - quote.discount;\n",
	"m-tests.ts":
		"import { total } from './a-logic';\nexport const expected = total({ subtotal: 100, discount: 20 }) === 80;\n",
};
function git(cwd, ...args) {
	return execFileSync(
		"git",
		["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
		{
			cwd,
			encoding: "utf8",
			timeout: 10_000,
			env: {
				PATH: process.env.PATH,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_OPTIONAL_LOCKS: "0",
				GIT_AUTHOR_NAME: "Controlled PR smoke",
				GIT_AUTHOR_EMAIL: "smoke@example.invalid",
				GIT_COMMITTER_NAME: "Controlled PR smoke",
				GIT_COMMITTER_EMAIL: "smoke@example.invalid",
				GIT_AUTHOR_DATE: "2026-10-31T12:00:00Z",
				GIT_COMMITTER_DATE: "2026-10-31T12:00:00Z",
			},
		}
	);
}
function createRepository(root) {
	const localPath = join(root, "repository");
	fs.mkdirSync(localPath);
	git(localPath, "init", "-b", "main");
	const moved = {
		...head,
		"a-logic.ts": head["a-logic.ts"].replace("quote.discount;", "quote.discount - 1;"),
	};
	const commits = [];
	for (const [label, sources] of [
		["base", base],
		["head", head],
		["moved", moved],
	]) {
		for (const path of order) fs.writeFileSync(join(localPath, path), sources[path]);
		git(localPath, "add", "--", ...order);
		git(localPath, "commit", "-m", `CONTROLLED ONLY: ${label}`);
		commits.push(git(localPath, "rev-parse", "HEAD").trim());
	}
	git(localPath, "remote", "add", "origin", `https://github.com/${repository}.git`);
	const filesAt = {};
	for (const sha of commits.slice(1)) {
		filesAt[sha] = [...order].reverse().map((filename) => {
			const diff = git(
				localPath,
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				commits[0],
				sha,
				"--",
				filename
			);
			const patch = diff.slice(diff.indexOf("@@")).trimEnd();
			return {
				filename,
				status: "modified",
				additions: patch.split("\n").filter((s) => s.startsWith("+")).length,
				deletions: patch.split("\n").filter((s) => s.startsWith("-")).length,
				patch,
			};
		});
	}
	// This reset is only in the newly created, owner-marked test repository.
	git(localPath, "reset", "--hard", commits[1]);
	const dirty = `${head["a-logic.ts"]}// CONTROLLED UNSAVED WORK: preserve byte-for-byte\n`;
	fs.writeFileSync(join(localPath, "a-logic.ts"), dirty);
	return {
		localPath,
		baseSha: commits[0],
		headSha: commits[1],
		movedSha: commits[2],
		filesAt,
		sourcesAt: { [commits[0]]: base, [commits[1]]: head, [commits[2]]: moved },
		dirty,
		status: git(localPath, "status", "--porcelain=v1"),
	};
}
function analysis() {
	return {
		summary: "CONTROLLED TEST ONLY: discount contract, implementation and check.",
		orderRationale: "CONTROLLED TEST ONLY: contract then implementation then check.",
		files: order.map((path) => ({
			path,
			reason: `CONTROLLED: inspect ${path}`,
			summary: `CONTROLLED: changes in ${path}`,
			suggestedComments: [],
		})),
	};
}
function modelResponse(body, id) {
	assert.equal(body.stream, true);
	assert.equal(body.store, false);
	assert.ok(
		body.tools.some((tool) => tool.name === "submit_prepared_review"),
		"Phase one permits only the actual background preparation model request"
	);
	return new Response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: `controlled-pr-work-${id}`,
				model: body.model,
				status: "completed",
				usage: null,
				output: [
					{
						type: "function_call",
						name: "submit_prepared_review",
						call_id: `prepare-${id}`,
						arguments: JSON.stringify(analysis()),
						status: "completed",
					},
				],
			},
		})}\n\n`,
		{ headers: { "content-type": "text/event-stream" } }
	);
}
function githubGET(address, fixture, liveHead) {
	const url = new URL(address);
	assert.equal(url.origin, "https://api.github.com");
	const viewer = "controlled-pr-reviewer";
	const metadata = {
		number: 7,
		state: "open",
		html_url: prURL,
		title: "CONTROLLED TEST ONLY: prepared PR comment",
		body: "Test fixture; never live review data.",
		changed_files: order.length,
		user: { login: "test-owner" },
		draft: false,
		updated_at: "2026-10-31T12:00:00Z",
		base: { sha: fixture.baseSha, ref: "main", repo: { full_name: repository } },
		head: { sha: liveHead, ref: "controlled-pr", repo: { full_name: repository } },
	};
	const repo = { full_name: repository, default_branch: "main", private: true };
	if (url.pathname === "/user")
		return {
			id: 9001,
			login: viewer,
			name: "CONTROLLED reviewer",
			avatar_url:
				"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
		};
	if (url.pathname === "/user/repos") return [repo];
	if (address === apiRoot) return repo;
	if (url.pathname === "/search/issues") {
		const q = url.searchParams.get("q");
		assert.ok(
			[
				`repo:${repository} is:pr is:open review-requested:${viewer}`,
				`repo:${repository} is:pr is:open author:${viewer}`,
			].includes(q)
		);
		const items = q.includes("review-requested:")
			? [{ number: 7, repository_url: apiRoot, pull_request: { url: `${apiRoot}/pulls/7` } }]
			: [];
		return { total_count: items.length, incomplete_results: false, items };
	}
	if (url.pathname === `/repos/${repository}/pulls`) return [metadata];
	if (address === `${apiRoot}/pulls/7`) return metadata;
	if (url.pathname === `/repos/${repository}/pulls/7/files`) return fixture.filesAt[liveHead];
	if (
		[
			`/repos/${repository}/pulls/7/comments`,
			`/repos/${repository}/pulls/7/reviews`,
			`/repos/${repository}/issues/7/comments`,
		].includes(url.pathname)
	)
		return [];
	// Existing local commits must be used; remote content is deliberately unavailable.
	throw new Error(`Unexpected controlled GitHub read: ${url.pathname}`);
}
function assertPOST(address, body, confirmation, fixture) {
	assert.equal(
		address,
		`${apiRoot}/pulls/7/comments`,
		"Only the exact inline PR comment endpoint is allowed"
	);
	assert.ok(confirmation?.requestId, "POST must descend from the real confirmation handler");
	assert.equal(confirmation.confirmed, true);
	assert.equal(body.body, confirmation.body);
	assert.equal(body.commit_id, fixture.headSha);
	assert.equal(body.path, order[1]);
	assert.equal(body.line, 2);
	assert.equal(body.side, "RIGHT");
	assert.deepEqual(Object.keys(body).sort(), ["body", "commit_id", "line", "path", "side"]);
}
module.exports = {
	repository,
	prId,
	prURL,
	apiRoot,
	modelURL,
	order,
	base,
	head,
	git,
	createRepository,
	analysis,
	modelResponse,
	githubGET,
	assertPOST,
};
