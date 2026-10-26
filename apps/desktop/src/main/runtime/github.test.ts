import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConfirmCommentInput, DraftedComment, PullRequest } from "../../shared/contracts";
import type { CredentialStore } from "./credentials";
import { GitHubClient } from "./github";

const sha = "a".repeat(40);
const pr: PullRequest = {
	id: "owner/shop#1",
	repository: "owner/shop",
	number: 1,
	url: "https://github.com/owner/shop/pull/1",
	author: "Noor",
	title: "Stack promos",
	baseSha: "b".repeat(40),
	headSha: sha,
};
const draft: DraftedComment = {
	id: "draft-1",
	prId: pr.id,
	revision: 1,
	headSha: sha,
	originalWords: "Flag the batch regression",
	body: "Could we skip expired codes in the nightly batch?",
	evidence: { kind: "fixture", fixtureId: "test", label: "Test" },
};
const confirmation: ConfirmCommentInput = {
	requestId: "confirmation-1",
	draftId: draft.id,
	draftRevision: draft.revision,
	headSha: sha,
	body: draft.body,
	confirmed: true,
};
const credentials = {
	get: async () => "never-print-this-test-token",
} as unknown as CredentialStore;
function fakeClient(head = sha) {
	const requests: { path: string; method: string; body?: string }[] = [];
	const transport = (async (url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		requests.push({ path, method: init?.method ?? "GET", body: init?.body as string | undefined });
		assert.equal(
			new Headers(init?.headers).get("Authorization"),
			"Bearer never-print-this-test-token"
		);
		const data = path.endsWith("/pulls/1")
			? {
					number: 1,
					html_url: pr.url,
					title: pr.title,
					user: { login: pr.author },
					base: { sha: pr.baseSha },
					head: { sha: head },
				}
			: { id: 123, html_url: "https://github.com/owner/shop/pull/1#issuecomment-123" };
		return Response.json(data);
	}) as typeof fetch;
	return { requests, client: new GitHubClient(credentials, transport) };
}

test("posts only an exact current confirmation and deduplicates concurrent retries", async () => {
	const { client, requests } = fakeClient();
	const results = await Promise.all([
		client.postConfirmedComment(pr, draft, confirmation),
		client.postConfirmedComment(pr, draft, confirmation),
	]);
	assert.equal(results[0]?.id, 123);
	assert.deepEqual(results[0], results[1]);
	assert.equal(requests.filter((request) => request.method === "POST").length, 1);
	assert.throws(
		() => client.postConfirmedComment(pr, draft, { ...confirmation, body: "changed" }),
		/mismatched/
	);
});

test("head movement and mismatched location block the write", async () => {
	const { client, requests } = fakeClient("c".repeat(40));
	await assert.rejects(client.postConfirmedComment(pr, draft, confirmation), /head changed/);
	assert.equal(requests.filter((request) => request.method === "POST").length, 0);
	const invalid = {
		...draft,
		location: {
			repository: "other/repo",
			revision: "head" as const,
			commitSha: sha,
			path: "price.ts",
			startLine: 1,
			endLine: 1,
		},
	};
	assert.throws(() => client.postConfirmedComment(pr, invalid, confirmation), /location/);
});

test("never repeats an ambiguous network write and rejects reused confirmation IDs", async () => {
	let posts = 0;
	const { client } = fakeClient();
	await client.postConfirmedComment(pr, draft, confirmation);
	assert.throws(
		() =>
			client.postConfirmedComment(
				pr,
				{ ...draft, body: "Different" },
				{ ...confirmation, body: "Different" }
			),
		/reused/
	);
	const transport = (async (_url: string | URL | Request, init?: RequestInit) => {
		if (init?.method === "POST") {
			posts++;
			throw new Error("Network lost after write");
		}
		return Response.json({
			number: 1,
			html_url: pr.url,
			title: pr.title,
			user: { login: pr.author },
			base: { sha: pr.baseSha },
			head: { sha },
		});
	}) as typeof fetch;
	const uncertain = new GitHubClient(credentials, transport);
	await assert.rejects(uncertain.postConfirmedComment(pr, draft, confirmation), /failed/);
	await assert.rejects(uncertain.postConfirmedComment(pr, draft, confirmation), /failed/);
	assert.equal(posts, 1);
});
