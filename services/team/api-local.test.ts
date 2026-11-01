import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type {
	ConversationPRContext,
	PreparedReview,
} from "../../apps/desktop/src/shared/contracts";
import { createTeamApiHandler } from "./edge/api";
import { dependencies, serverHandler } from "./entry";
import { digest } from "./protocol";

const org = "10000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000001";
const otherUser = "00000000-0000-4000-8000-000000000002";
const env = {
	SUPABASE_URL: "https://db.example",
	SUPABASE_PUBLISHABLE_KEY: "public",
	SUPABASE_SERVICE_ROLE_KEY: "server-only",
	TEAM_ANALYSIS_VERSION: "test-v1",
};
const context: ConversationPRContext = {
	pr: {
		id: "test/repo#1",
		repository: "test/repo",
		number: 1,
		url: "https://github.com/test/repo/pull/1",
		title: "Exact PR",
		author: "author",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
	},
	description: "Exact source description",
	truncated: false,
	files: ["a.ts", "b.ts"].map((path) => ({
		path,
		status: "modified",
		additions: 1,
		deletions: 1,
		patch: "@@ -1 +1 @@\n-old\n+new",
	})),
};
const key = {
	orgId: org,
	repositoryId: "42",
	prNumber: 1,
	baseSha: context.pr.baseSha,
	headSha: context.pr.headSha,
	contextDigest: digest(context),
	analysisVersion: env.TEAM_ANALYSIS_VERSION,
};
function review(): PreparedReview {
	return {
		id: "local-review",
		version: 1,
		pr: { ...context.pr },
		createdAt: "2026-11-01T00:00:00Z",
		summary: "Reported local inference",
		orderRationale: "Read dependencies first",
		files: [...context.files].reverse().map((file) => ({
			path: file.path,
			summary: "Changed behavior",
			reason: "Read source",
			suggestedComments: [],
		})),
		coverage: "complete",
		evidence: "inferred-from-github",
	};
}
function submission(r = review(), k = key) {
	return { requestId: randomUUID(), key: k, review: r, digest: digest({ key: k, review: r }) };
}
function fixture() {
	const state = {
		member: true,
		owner: true,
		repoAdmin: true,
		subject: "101",
		repoId: 42,
		repoAllowed: true,
		head: context.pr.headSha,
		description: context.description,
		title: context.pr.title,
		finalChanged: false,
		publishCalls: 0,
		headWrites: 0,
		appReads: 0,
		registrations: 0,
		identityReads: 0,
		canonical: null as Record<string, unknown> | null,
	};
	const requests = new Map<string, string>();
	const transport = (async (raw: unknown, init?: RequestInit) => {
		const url = new URL(String(raw));
		const path = url.pathname;
		const headers = new Headers(init?.headers);
		if (url.hostname === "api.github.com") {
			assert.equal(headers.get("authorization"), "Bearer end-user-token");
			assert.equal(init?.method ?? "GET", "GET");
			if (path.includes("installation") || path.startsWith("/app")) {
				state.appReads++;
				assert.fail("No GitHub App reads");
			}
			if (path === "/user") return Response.json({ id: 101, login: "author" });
			if (path === "/repositories/42" || path === "/repos/test/repo")
				return Response.json(
					{
						id: state.repoId,
						full_name: "test/repo",
						permissions: { admin: state.repoAdmin },
					},
					{ status: state.repoAllowed ? 200 : 404 }
				);
			if (path === "/repos/test/repo/pulls/1/files")
				return Response.json(context.files.map((file) => ({ ...file, filename: file.path })));
			if (path === "/repos/test/repo/pulls/1")
				return Response.json({
					number: 1,
					html_url: context.pr.url,
					title: state.title,
					body: state.description,
					user: { id: 101, login: "author" },
					head: { sha: state.head },
					base: { sha: context.pr.baseSha, repo: { id: 42 } },
					changed_files: 2,
				});
			assert.fail(`Unexpected source ${path}`);
		}
		assert.equal(url.origin, env.SUPABASE_URL);
		if (path === "/auth/v1/user") {
			state.identityReads++;
			return Response.json({
				id: user,
				identities: [{ provider: "github", identity_data: { sub: state.subject } }],
			});
		}
		if (path === "/rest/v1/team_memberships")
			return Response.json(state.member ? [{ active: true }] : []);
		if (path === "/rest/v1/team_organization_owners")
			return Response.json(state.member && state.owner ? [{ org_id: org }] : []);
		if (path === "/rest/v1/team_repositories")
			return Response.json([
				{
					org_id: org,
					repository_id: "42",
					full_name: "test/repo",
					installation_id: null,
					enabled: true,
				},
			]);
		if (path === "/rest/v1/team_repository_grants") return new Response(null, { status: 204 });
		if (path === "/rest/v1/team_pr_heads") {
			state.headWrites++;
			const body = JSON.parse(String(init?.body));
			assert.equal(body.context_digest, key.contextDigest);
			assert.equal(body.base_sha, key.baseSha);
			assert.equal(body.github_author_id, "101");
			return new Response(null, { status: 204 });
		}
		if (path === "/rest/v1/rpc/team_publish_local_review") {
			assert.equal(headers.get("apikey"), "server-only");
			const body = JSON.parse(String(init?.body));
			assert.equal(body.p_actor, user);
			state.publishCalls++;
			const bound = requests.get(body.p_request);
			if (bound && bound !== body.p_digest)
				return Response.json({ code: "40001" }, { status: 409 });
			state.canonical ??= {
				key: body.p_key,
				review: body.p_review,
				digest: body.p_digest,
				origin: "local",
				prepared_by: user,
			};
			requests.set(body.p_request, body.p_digest);
			return Response.json(state.canonical);
		}
		if (path === "/rest/v1/team_review_artifacts")
			return Response.json(state.canonical ? [state.canonical] : []);
		if (path === "/rest/v1/rpc/team_register_repository") {
			const body = JSON.parse(String(init?.body));
			state.registrations++;
			assert.equal(body.p_installation, null);
			assert.equal(body.p_user, user);
			assert.equal(body.p_repository, "42");
			return Response.json({ orgId: org, repositoryId: "42", fullName: "test/repo" });
		}
		if (path === "/rest/v1/rpc/team_create_organization")
			return Response.json({ id: org, name: "Local team" });
		assert.fail(`Unexpected database ${path}`);
	}) as typeof fetch;
	const handler = createTeamApiHandler(env, { fetch: transport });
	const call = (path: string, body: unknown) =>
		handler(
			new Request(`https://edge.example/functions/v1/muse-team-api/v1/${path}`, {
				method: "POST",
				headers: { Authorization: "Bearer user-jwt", "x-github-token": "end-user-token" },
				body: JSON.stringify(body),
			})
		);
	return { state, call };
}

test("active API/serve configure with only Supabase and version; no App/model/webhook credentials", async () => {
	assert.ok(dependencies(env));
	const handler = serverHandler(env);
	assert.equal((await handler(new Request("https://service.example/health"))).status, 200);
	assert.equal(
		(
			await handler(
				new Request("https://service.example/webhooks/github", { method: "POST", body: "{}" })
			)
		).status,
		404
	);
	const api = createTeamApiHandler({
		...env,
		GITHUB_APP_ID: "invalid",
		GITHUB_APP_PRIVATE_KEY: "invalid",
		MODEL_API_KEY: "",
	});
	assert.equal((await api(new Request("https://edge.example/health"))).status, 200);
	const { state, call } = fixture();
	for (const path of ["reviews/request", "reviews/retry"])
		assert.equal((await call(path, { key })).status, 410);
	assert.equal(state.identityReads, 0);
	assert.equal(state.publishCalls, 0);
});
test("local-only onboarding requires matched identity, active owner and fresh GitHub admin; always stores NULL", async () => {
	const { state, call } = fixture();
	assert.equal(
		(await call("organizations/create", { name: "Local team", requestId: randomUUID() })).status,
		200
	);
	const input = {
		orgId: org,
		repository: "test/repo",
		requestId: randomUUID(),
		installationId: "999",
	};
	assert.equal((await call("repositories/register", input)).status, 200);
	assert.equal(state.registrations, 1);
	assert.equal(state.appReads, 0);
	state.owner = false;
	assert.equal((await call("repositories/register", input)).status, 403);
	state.owner = true;
	state.member = false;
	assert.equal((await call("repositories/register", input)).status, 403);
	state.member = true;
	state.repoAdmin = false;
	assert.equal((await call("repositories/register", input)).status, 403);
	state.repoAdmin = true;
	state.subject = "102";
	assert.equal((await call("repositories/register", input)).status, 403);
	assert.equal(state.registrations, 1);
});
test("publish/read map canonical local attribution, preserve first writer, and never change the digest with attribution", async () => {
	const { state, call } = fixture();
	const input = submission();
	const published = await call("reviews/publish", input);
	assert.equal(published.status, 200);
	const canonical = await published.json();
	assert.deepEqual(canonical, {
		key,
		review: input.review,
		digest: input.digest,
		provenance: "reported-local-analysis",
		preparedBy: user,
	});
	assert.equal(digest({ key: canonical.key, review: canonical.review }), canonical.digest);
	assert.deepEqual(await (await call("reviews/read", { key })).json(), canonical);
	const competing = submission({ ...review(), summary: "Another local inference" });
	assert.deepEqual(await (await call("reviews/publish", competing)).json(), canonical);
	assert.deepEqual(await (await call("reviews/publish", competing)).json(), canonical);
	const rebound = { ...competing, review: input.review, digest: input.digest };
	assert.equal((await call("reviews/publish", rebound)).status, 409);
	// Attribution comes from stored server rows, never the caller's optional wire fields.
	assert.equal((await call("reviews/publish", { ...input, preparedBy: otherUser })).status, 400);
	assert.equal(state.publishCalls, 4);
	assert.equal(state.appReads, 0);
	state.canonical = {
		key,
		review: input.review,
		digest: input.digest,
		origin: null,
		prepared_by: null,
	};
	const legacy = await (await call("reviews/read", { key })).json();
	assert.deepEqual(legacy, { key, review: input.review, digest: input.digest });
});
test("publish rejects stale source context, forged identity/version/digest/file set and lost access before storage", async () => {
	const invalid = [
		{ ...submission(), digest: "0".repeat(64) },
		submission(review(), { ...key, analysisVersion: "other-v1" }),
		submission(review(), { ...key, contextDigest: "0".repeat(64) }),
		submission({ ...review(), pr: { ...context.pr, title: "Forged title" } }),
		submission({ ...review(), pr: { ...context.pr, repository: "other/repo" } }),
		submission({ ...review(), files: review().files.slice(1) }),
		submission({
			...review(),
			files: [
				...review().files,
				{ path: "not-supplied.ts", summary: "Fake", reason: "Fake", suggestedComments: [] },
			],
		}),
		submission({
			...review(),
			files: review().files.map((file) => ({
				...file,
				suggestedComments: [
					{
						id: "suggestion",
						body: "question",
						location: {
							repository: "test/repo",
							revision: "head" as const,
							commitSha: "f".repeat(40),
							path: file.path,
							startLine: 1,
							endLine: 1,
						},
					},
				],
			})),
		}),
	];
	for (const input of invalid) {
		const { state, call } = fixture();
		const result = await call("reviews/publish", input);
		assert.ok([400, 409].includes(result.status), String(result.status));
		assert.equal(state.publishCalls, 0);
		assert.equal(state.headWrites, 0);
	}
	for (const mutation of [
		{ subject: "102" },
		{ member: false },
		{ repoAllowed: false },
		{ repoId: 43 },
		{ head: "f".repeat(40) },
		{ description: "Updated source description" },
		{ title: "Updated title" },
	]) {
		const { state, call } = fixture();
		Object.assign(state, mutation);
		assert.ok([403, 409].includes((await call("reviews/publish", submission())).status));
		assert.equal(state.publishCalls, 0);
	}
});
