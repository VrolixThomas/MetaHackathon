import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { type ReviewKey, type TeamSession, digest } from "../../../../../services/team/protocol";
import { TeamAuth } from "./auth";
import { TeamClient } from "./client";
import type { TeamStore } from "./storage";

const userId = "00000000-0000-4000-8000-000000000001";
const key: ReviewKey = {
	orgId: "10000000-0000-4000-8000-000000000001",
	repositoryId: "42",
	prNumber: 1,
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	contextDigest: "c".repeat(64),
	analysisVersion: "test-v1",
};
const review = {
	id: "review-controlled",
	version: 1,
	pr: {
		id: "test/repo#1",
		repository: "test/repo",
		number: 1,
		url: "https://github.com/test/repo/pull/1",
		title: "Controlled test",
		author: "test",
		baseSha: key.baseSha,
		headSha: key.headSha,
	},
	createdAt: "2026-11-01T00:00:00Z",
	summary: "Controlled analysis",
	orderRationale: "Read changed file",
	files: [],
	coverage: "complete",
	evidence: "inferred-from-github",
};
const shared = { key, review, digest: digest({ key, review }) };
function store(): TeamStore {
	let value: unknown = null;
	return {
		read: async () => structuredClone(value),
		write: async (next) => {
			value = structuredClone(next);
		},
	};
}
function session(id = userId): TeamSession {
	return {
		user: { id },
		access_token: "supabase-user-jwt",
		refresh_token: "refresh-secret",
		expires_at: 2000000000,
	};
}
function transport(
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): typeof fetch {
	return (async (url, init) => handler(String(url), init)) as typeof fetch;
}

test("Supabase PKCE exchange binds random loopback path, never accepts provider token as session", async () => {
	const saved = store();
	let sent: Record<string, unknown> = {};
	const auth = new TeamAuth({
		url: "https://example.supabase.co",
		publishableKey: "sb_publishable_test",
		store: saved,
		fetch: transport((url, init) => {
			assert.match(url, /grant_type=pkce/);
			sent = JSON.parse(String(init?.body));
			return Response.json({ ...session(), provider_token: "github-oauth-never-persist" });
		}),
	});
	const url = new URL(auth.beginLogin("http://127.0.0.1:43189"));
	const redirect = url.searchParams.get("redirect_to");
	assert.ok(redirect);
	assert.equal(url.searchParams.get("code_challenge_method"), "s256");
	await assert.rejects(auth.finishLogin("http://127.0.0.1:43189/team-auth/wrong?code=bad"));
	const next = new URL(auth.beginLogin("http://127.0.0.1:43189"));
	await auth.finishLogin(`${next.searchParams.get("redirect_to")}?code=verified`);
	assert.equal(sent.auth_code, "verified");
	assert.equal(typeof sent.code_verifier, "string");
	assert.equal(((await saved.read()) as Record<string, unknown>).provider_token, undefined);
	await assert.rejects(auth.finishLogin(`${redirect}?code=replay`));
});
test("refresh failure fails closed; no GitHub credential fallback or admin keys", async () => {
	const saved = store();
	await saved.write({ ...session(), expires_at: 1 });
	const auth = new TeamAuth({
		url: "https://example.supabase.co",
		publishableKey: "sb_publishable_test",
		store: saved,
		fetch: transport(() => Response.json({ error: "invalid" }, { status: 401 })),
	});
	await assert.rejects(auth.session());
	assert.equal(await saved.read(), null);
	assert.throws(
		() =>
			new TeamAuth({
				url: "https://example.supabase.co",
				publishableKey: "sb_secret_admin",
				store: saved,
			})
	);
});
test("cache exact revision shared artifact; offline is explicitly stale and account private; denial never falls back", async () => {
	let current = session();
	let mode = "online";
	const cache = store();
	const client = new TeamClient({
		url: "https://team.example",
		auth: { session: async () => current },
		getGitHubToken: async () => "github-user",
		cache,
		fetch: transport((_url, init) => {
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer supabase-user-jwt");
			if (mode === "offline") throw new Error("controlled offline");
			return Response.json(shared, { status: mode === "denied" ? 403 : 200 });
		}),
	});
	assert.equal((await client.load(key)).status, "current");
	mode = "offline";
	assert.equal((await client.load(key)).artifact?.digest, shared.digest);
	assert.equal((await client.load(key)).status, "offline-cache");
	assert.equal((await client.load({ ...key, headSha: "d".repeat(40) })).artifact, null);
	current = session("00000000-0000-4000-8000-000000000002");
	assert.equal((await client.load(key)).artifact, null);
	current = session();
	mode = "denied";
	await assert.rejects(client.load(key));
});
test("progress outbox durable before send; exact retry identity survives disconnect and conflict", async () => {
	const cache = store();
	let online = false;
	let submitted = 0;
	const opts = {
		url: "https://team.example",
		auth: { session: async () => session() },
		getGitHubToken: async () => "github-user",
		cache,
		fetch: transport(async (_url, init) => {
			const raw = (await cache.read()) as { pending: unknown[] };
			assert.equal(raw.pending.length, 1);
			if (!online) throw new Error("offline");
			submitted++;
			const body = JSON.parse(String(init?.body));
			return Response.json({ ...body.progress, revision: 1 });
		}),
	};
	const input = {
		requestId: randomUUID(),
		expectedRevision: 0,
		progress: { key, cursor: null, visited: [], notes: "private", paused: false, revision: 0 },
	};
	assert.equal((await new TeamClient(opts).saveProgress(input)).status, "pending");
	await assert.rejects(
		new TeamClient(opts).saveProgress({
			...input,
			progress: { ...input.progress, notes: "changed" },
		})
	);
	online = true;
	assert.equal(await new TeamClient(opts).flushProgress(), 1);
	assert.equal(submitted, 1);
});
