import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { TeamAccess } from "./access";
import { createTeamApi } from "./api";
import type { ProposalBundle } from "./proposals";
import { digest, sha256 } from "./protocol";
import { SupabaseRest } from "./supabase";

const org = "10000000-0000-4000-8000-000000000001";
const ids = {
	a: "00000000-0000-4000-8000-000000000001",
	b: "00000000-0000-4000-8000-000000000002",
	c: "00000000-0000-4000-8000-000000000003",
};
const key = {
	orgId: org,
	repositoryId: "42",
	prNumber: 1,
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	contextDigest: "c".repeat(64),
	analysisVersion: "test-v1",
};
const blob = (text: string) => ({ text, sha256: sha256(text) });
function bundle(): ProposalBundle {
	const files = [{ path: "a.ts", before: blob("old\n"), after: blob("new\n") }];
	return {
		key,
		feedback: {
			kind: "pull-review-comment",
			id: "9",
			revision: "2026-11-01T00:00:00Z",
			body: "Fix this",
			bodyDigest: sha256("Fix this"),
		},
		baseSha: key.headSha,
		candidateSha: "f".repeat(40),
		files,
		sourcesDigest: digest(files),
		patch: blob("@@ -1 +1 @@\n-old\n+new\n"),
		checks: [],
		checksDigest: digest([]),
		provenance: "reported-local-candidate",
	};
}

test("two-user HTTP exchange shares exact source/patch/check bundle and only current author can decide", async () => {
	let head = key.headSha;
	let feedbackRevision = "2026-11-01T00:00:00Z";
	let denyB = false;
	let shared: Record<string, unknown> | null = null;
	let decisions = 0;
	let decisionRecord: Record<string, unknown> | null = null;
	let verifiedFeedback = 0;
	const transport = (async (raw: unknown, init?: RequestInit) => {
		const url = new URL(String(raw));
		const token = (new Headers(init?.headers).get("authorization") ?? "").slice(7);
		const actor = token.endsWith("b") ? "b" : token.endsWith("c") ? "c" : "a";
		if (url.hostname === "api.github.com") {
			assert.equal(init?.method ?? "GET", "GET");
			if (url.pathname === "/user")
				return Response.json({ id: actor === "a" ? 101 : actor === "b" ? 102 : 103, login: actor });
			if (url.pathname === "/repositories/42")
				return Response.json(
					{ id: 42, full_name: "test/repo" },
					{ status: actor === "b" && denyB ? 404 : 200 }
				);
			if (url.pathname === "/repos/test/repo/pulls/1")
				return Response.json({
					number: 1,
					user: { id: 102 },
					head: { sha: head },
					base: { repo: { id: 42 } },
				});
			if (url.pathname === "/repos/test/repo/pulls/comments/9")
				return Response.json({
					id: 9,
					body: "Fix this",
					updated_at: feedbackRevision,
					pull_request_url: "https://api.github.com/repos/test/repo/pulls/1",
				});
		}
		if (url.pathname.endsWith("/auth/v1/user"))
			return Response.json({
				id: ids[actor],
				identities: [
					{
						provider: "github",
						identity_data: { sub: String(actor === "a" ? 101 : actor === "b" ? 102 : 103) },
					},
				],
			});
		if (url.pathname.endsWith("team_memberships"))
			return Response.json(
				url.searchParams.get("user_id") === `eq.${ids.c}` ? [] : [{ active: true }]
			);
		if (url.pathname.endsWith("team_repositories"))
			return Response.json([
				{
					org_id: org,
					repository_id: "42",
					full_name: "test/repo",
					installation_id: "7",
					enabled: true,
				},
			]);
		if (url.pathname.endsWith("team_repository_grants") || url.pathname.endsWith("team_pr_heads"))
			return new Response(null, { status: 204 });
		if (url.pathname.endsWith("team_feedback_revisions")) {
			verifiedFeedback++;
			return new Response(null, { status: 204 });
		}

		if (url.pathname.endsWith("/rpc/team_find_shared_proposal")) {
			const input = JSON.parse(String(init?.body));
			return Response.json(
				shared?.["request_id"] === input.p_request && shared?.["bundle_digest"] === input.p_digest
					? shared
					: null
			);
		}
		if (url.pathname.endsWith("team_proposal_decisions"))
			return Response.json(
				decisionRecord &&
					url.searchParams.get("request_id") === `eq.${decisionRecord["request_id"]}`
					? [decisionRecord]
					: []
			);
		if (url.pathname.endsWith("/rpc/team_share_proposal")) {
			const input = JSON.parse(String(init?.body));
			shared ??= {
				id: randomUUID(),
				org_id: org,
				repository_id: "42",
				key,
				owner_id: ids.a,
				request_id: input.p_request,
				bundle: input.p_bundle,
				bundle_digest: input.p_digest,
				created_at: "2026-11-01T00:00:00Z",
			};
			return Response.json(shared);
		}
		if (url.pathname.endsWith("team_fix_proposals")) return Response.json(shared ? [shared] : []);
		if (url.pathname.endsWith("/rpc/team_decide_proposal")) {
			decisions++;
			const input = JSON.parse(String(init?.body));
			decisionRecord = {
				id: randomUUID(),
				request_id: input.p_request,
				proposal_id: input.p_id,
				bundle_digest: input.p_digest,
				decision: input.p_decision,
			};
			return Response.json({
				id: decisionRecord["id"],
				proposal_id: input.p_id,
				bundle_digest: input.p_digest,
				decision: input.p_decision,
			});
		}
		throw new Error(`Unexpected controlled route ${url.pathname}`);
	}) as typeof fetch;
	const admin = new SupabaseRest({
		url: "https://db.example",
		key: "server-only",
		fetch: transport,
	});
	const access = new TeamAccess({
		admin,
		user: (token) =>
			new SupabaseRest({ url: "https://db.example", key: "public", token, fetch: transport }),
		fetch: transport,
	});
	const api = createTeamApi(access, {
		admin,
		github: {
			context: async () => {
				throw new Error("Unexpected context read");
			},
		},
		analysisVersion: "test-v1",
	});
	const call = (actor: "a" | "b" | "c", path: string, body: unknown) =>
		api(
			new Request(`https://team.example/v1/${path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer jwt-${actor}`,
					"x-github-token": `github-${actor}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			})
		);
	const candidate = bundle();
	const share = { requestId: randomUUID(), bundle: candidate, bundleDigest: digest(candidate) };
	assert.equal((await call("a", "proposals/share", share)).status, 200);
	assert.equal(verifiedFeedback, 1);
	const read = await call("b", "proposals/read", { key, proposalId: shared?.["id"] });
	assert.equal(read.status, 200);
	const value = (await read.json()) as { bundle: ProposalBundle; bundle_digest: string };
	assert.equal(digest(value.bundle), value.bundle_digest);
	assert.equal(value.bundle.files[0]?.after?.text, "new\n");
	assert.equal(
		(await call("c", "proposals/read", { key, proposalId: shared?.["id"] })).status,
		403
	);
	const decision = {
		key,
		proposalId: shared?.["id"],
		bundleDigest: share.bundleDigest,
		decision: "accept",
		requestId: randomUUID(),
		confirmed: true,
	};
	assert.equal((await call("a", "proposals/decide", decision)).status, 403);
	assert.equal(
		(await call("b", "proposals/decide", { ...decision, confirmed: false })).status,
		400
	);
	assert.equal((await call("b", "proposals/decide", decision)).status, 200);
	assert.equal(decisions, 1);
	head = "e".repeat(40);
	assert.equal((await call("b", "proposals/decide", decision)).status, 200);
	assert.equal(
		(await call("b", "proposals/decide", { ...decision, requestId: randomUUID() })).status,
		409
	);
	head = key.headSha;
	feedbackRevision = "2026-11-01T00:01:00Z";
	assert.equal(
		(await call("a", "proposals/share", { ...share, requestId: randomUUID() })).status,
		409
	);
	denyB = true;
	assert.equal(
		(await call("b", "proposals/read", { key, proposalId: shared?.["id"] })).status,
		403
	);
	const tampered = { ...candidate, patch: { ...candidate.patch, text: "tampered" } };
	assert.equal(
		(
			await call("a", "proposals/share", {
				...share,
				bundle: tampered,
				bundleDigest: digest(tampered),
			})
		).status,
		400
	);
});

test("shared review HTTP read revalidates exact current context so old heads/descriptions are never current", async () => {
	const context = {
		pr: {
			id: "test/repo#1",
			repository: "test/repo",
			number: 1,
			url: "https://github.com/test/repo/pull/1",
			title: "Exact PR",
			author: "author",
			baseSha: key.baseSha,
			headSha: key.headSha,
		},
		description: "Exact source description",
		files: [],
		truncated: false,
	};
	const exactKey = { ...key, contextDigest: digest(context) };
	const review = {
		id: "controlled-review",
		version: 1,
		pr: context.pr,
		createdAt: "2026-11-01T00:00:00Z",
		summary: "Controlled inference",
		orderRationale: "Read source",
		files: [],
		coverage: "complete",
		evidence: "inferred-from-github",
	};
	const artifact = { key: exactKey, review, digest: digest({ key: exactKey, review }) };
	const db = new SupabaseRest({
		url: "https://db.example",
		key: "public",
		token: "user",
		fetch: (async () => Response.json([artifact])) as typeof fetch,
	});
	let currentDigest = exactKey.contextDigest;
	const access = {
		authorize: async () => ({
			db,
			userId: ids.a,
			githubId: "101",
			githubLogin: "a",
			repository: {
				org_id: org,
				repository_id: "42",
				full_name: "test/repo",
				installation_id: "7",
				enabled: true,
			},
		}),
		github: async () => {
			throw new Error("Unexpected user read");
		},
	};
	const api = createTeamApi(
		{
			...access,
			organizations: async () => [],
			repositories: async () => ({ items: [], nextOffset: null }),
		},
		{
			admin: db,
			github: { context: async () => ({ context, contextDigest: currentDigest }) },
			analysisVersion: "test-v1",
		}
	);
	const call = () =>
		api(
			new Request("https://team.example/v1/reviews/read", {
				method: "POST",
				headers: { Authorization: "Bearer user", "x-github-token": "user-github" },
				body: JSON.stringify({ key: exactKey }),
			})
		);
	const first = await call();
	assert.equal(first.status, 200);
	assert.equal(((await first.json()) as { digest: string }).digest, artifact.digest);
	currentDigest = digest({ ...context, description: "New description, same code SHAs" });
	assert.equal((await call()).status, 409);
});
