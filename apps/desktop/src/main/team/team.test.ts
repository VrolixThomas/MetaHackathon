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
			const raw = (await cache.read()) as { accounts: Record<string, { pending: unknown[] }> };
			assert.equal(raw.accounts[userId]?.pending.length, 1);
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

test("cancelled PKCE exchange cannot persist a late account session", async () => {
	const saved = store();
	let complete: ((response: Response) => void) | undefined;
	const auth = new TeamAuth({
		url: "https://example.supabase.co",
		publishableKey: "sb_publishable_test",
		store: saved,
		fetch: transport(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				})
		),
	});
	const authorize = new URL(auth.beginLogin("http://127.0.0.1:43189"));
	const pending = auth.finishLogin(`${authorize.searchParams.get("redirect_to")}?code=controlled`);
	auth.cancelLogin();
	assert.ok(complete);
	complete(Response.json(session()));
	await assert.rejects(pending);
	assert.equal(await saved.read(), null);
});

test("encrypted team file reopens durable state with private permissions using controlled encryption", async () => {
	const { mkdtemp, readFile, rm, stat } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { EncryptedTeamStore } = await import("./storage");
	const directory = await mkdtemp(join(tmpdir(), "muse-team-store-"));
	// Controlled encryption stand-in: this test does not establish macOS safeStorage behavior.
	const encryption = {
		isEncryptionAvailable: () => true,
		encryptString: (text: string) => Buffer.from(Buffer.from(text).map((value) => value ^ 0x5a)),
		decryptString: (bytes: Buffer) =>
			Buffer.from(bytes.map((value) => value ^ 0x5a)).toString("utf8"),
	};
	try {
		const path = join(directory, "session.bin");
		await new EncryptedTeamStore(path, encryption).write(session());
		assert.deepEqual(await new EncryptedTeamStore(path, encryption).read(), session());
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await readFile(path)).includes(Buffer.from("refresh-secret")), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("offline outboxes survive account switches separately and never dispatch old private progress as the next user", async () => {
	let current = session();
	let changeDuringCredential = false;
	let sent = 0;
	const cache = store();
	const auth = { session: async () => current };
	const client = new TeamClient({
		url: "https://team.example",
		auth,
		getGitHubToken: async () => {
			if (changeDuringCredential) current = session("00000000-0000-4000-8000-000000000002");
			return "github-current";
		},
		cache,
		fetch: transport(() => {
			sent++;
			throw new Error("Controlled offline");
		}),
	});
	const write = (notes: string) => ({
		requestId: randomUUID(),
		expectedRevision: 0,
		progress: { key, cursor: null, visited: [], notes, paused: false, revision: 0 },
	});
	await client.saveProgress(write("private A"));
	current = session("00000000-0000-4000-8000-000000000002");
	await client.saveProgress(write("private B"));
	const stored = (await cache.read()) as {
		accounts: Record<string, { pending: { progress: { notes: string } }[] }>;
	};
	assert.equal(stored.accounts[userId]?.pending[0]?.progress.notes, "private A");
	assert.equal(stored.accounts[current.user.id]?.pending[0]?.progress.notes, "private B");
	current = session();
	changeDuringCredential = true;
	const before = sent;
	await assert.rejects(client.saveProgress(write("late private A")));
	assert.equal(sent, before);
});
