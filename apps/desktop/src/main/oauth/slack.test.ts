import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { describe, test } from "node:test";
import { OAUTH_CALLBACK_URLS, OAuthStatusListSchema } from "../../shared/contracts/oauth";
import { SLACK_USER_SCOPES } from "../slack/oauth";
import { OAuthError, OAuthService } from "./service";
import { OAuthStore } from "./store";
import { begin, complete, deferred, encryption, harness, send, until } from "./test-support";

type Harness = Awaited<ReturnType<typeof harness>>;
const userTokens = {
	access_token: "slack-user-access",
	token_type: "user",
	scope: "users:read,chat:write",
	refresh_token: "slack-user-refresh",
	expires_in: 43200,
};
const initialGrant = {
	ok: true,
	app_id: "A123",
	team: { id: "T123" },
	authed_user: { id: "U123", ...userTokens },
	// Even if a response carries legacy bot credentials, only authed_user is usable.
	access_token: "never-use-bot",
	token_type: "bot",
};
const rotated = {
	ok: true,
	...userTokens,
	access_token: "rotated-user-access",
	refresh_token: "rotated-user-refresh",
};
function provider(h: Harness) {
	const state = {
		grant: initialGrant as unknown,
		refresh: rotated as unknown,
		auth: { ok: true, team_id: "T123", user_id: "U123" } as unknown,
		user: {
			ok: true,
			user: {
				id: "U123",
				team_id: "T123",
				name: "viewer",
				profile: { real_name: "Private Slack Name" },
			},
		} as unknown,
		gate: Promise.resolve(),
	};
	h.setHandler(async (entry, response) => {
		if (entry.url.endsWith("/oauth.v2.access")) {
			const form = new URLSearchParams(entry.body);
			assert.equal(form.get("client_id"), "controlled-slack-client");
			assert.equal(form.get("client_secret"), null);
			assert.equal(entry.headers.authorization, undefined);
			assert.ok(!entry.body.includes("configured-slack-secret"));
			if (form.get("grant_type") === "refresh_token") {
				assert.equal(form.get("code_verifier"), null);
				await state.gate;
				send(response, state.refresh);
			} else send(response, state.grant);
		} else if (entry.url.endsWith("/auth.test")) send(response, state.auth);
		else if (entry.url.endsWith("/users.info")) {
			assert.equal(JSON.parse(entry.body).user, (state.auth as { user_id: string }).user_id);
			send(response, state.user);
		} else send(response, {}, 404);
	});
	return state;
}
async function callback(
	redirect: string,
	query: string,
	host = new URL(redirect).host,
	method = "GET"
) {
	const url = new URL(redirect);
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const outgoing = request(
			{
				hostname: "127.0.0.1",
				port: url.port,
				path: `${url.pathname}?${query}`,
				method,
				headers: { Host: host },
			},
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					body += chunk;
				});
				response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
			}
		);
		outgoing.on("error", reject);
		outgoing.end();
	});
}
const isError = (code: string) => (error: unknown) =>
	error instanceof OAuthError && error.code === code;
async function saved(h: Harness) {
	return new OAuthStore(h.options.directory, h.options.encryption).get("slack");
}
async function settled(h: Harness) {
	return until(
		async () => (await h.service.status()).find((row) => row.provider === "slack"),
		(row) => row?.phase !== "connecting"
	);
}

describe("Slack desktop PKCE integration with controlled transport", () => {
	test("localhost callback, public client, user-only scopes, verified private identity and three public statuses", async () => {
		const h = await harness();
		h.clients.slack = {
			clientId: "controlled-slack-client",
			clientSecret: "configured-slack-secret",
		};
		provider(h);
		assert.equal((await h.service.status())[2]?.callbackUrl, OAUTH_CALLBACK_URLS.slack);
		const flow = await begin(h, "slack");
		assert.equal(new URL(flow.redirect).hostname, "localhost");
		assert.equal(new URL(flow.redirect).pathname, "/oauth/slack/callback");
		assert.equal(
			flow.authorize.origin + flow.authorize.pathname,
			"https://slack.com/oauth/v2/authorize"
		);
		assert.equal(flow.authorize.searchParams.get("scope"), null);
		assert.equal(flow.authorize.searchParams.get("user_scope"), SLACK_USER_SCOPES.join(","));
		assert.equal(flow.authorize.searchParams.get("code_challenge_method"), "S256");
		assert.equal(Buffer.from(flow.state, "base64url").length, 32);
		const result = await callback(flow.redirect, `code=private-code&state=${flow.state}`);
		assert.equal(result.status, 200);
		assert.ok(!result.body.includes(flow.state) && !result.body.includes("private-code"));
		assert.equal((await settled(h))?.phase, "connected");
		const form = new URLSearchParams(h.requests[0]?.body);
		assert.equal(form.get("redirect_uri"), flow.redirect);
		assert.equal(form.get("grant_type"), "authorization_code");
		assert.equal(
			createHash("sha256")
				.update(form.get("code_verifier") ?? "")
				.digest("base64url"),
			flow.authorize.searchParams.get("code_challenge")
		);
		assert.deepEqual(
			h.requests.slice(1).map((entry) => entry.url),
			["https://slack.com/api/auth.test", "https://slack.com/api/users.info"]
		);
		assert.equal(h.requests[1]?.headers.authorization, "Bearer slack-user-access");
		const session = await saved(h);
		assert.deepEqual(session?.slack, { appId: "A123", workspaceId: "T123", userId: "U123" });
		assert.equal(session?.refreshExpiresAt, h.clock.value + 30 * 86400000);
		const credential = await h.service.slackCredential();
		assert.equal(h.requests.length, 3, "unexpired getter must not issue network requests");
		assert.deepEqual(credential, {
			connectionId: session?.id,
			accessToken: "slack-user-access",
			tokenKind: "user",
			appId: "A123",
			workspaceId: "T123",
			userId: "U123",
			scopes: ["users:read", "chat:write"],
		});
		const statuses = OAuthStatusListSchema.parse(await h.service.status());
		assert.equal(statuses[2]?.account?.workspaceId, "T123");
		assert.deepEqual(
			statuses.map((row) => row.provider),
			["github", "linear", "slack"]
		);
		for (const secret of [
			session?.id,
			"slack-user-access",
			"slack-user-refresh",
			"configured-slack-secret",
			"A123",
		])
			assert.ok(secret && !JSON.stringify(statuses).includes(secret));
		const bytes = await readFile(
			join(h.options.directory, "oauth.sessions.encrypted.json"),
			"utf8"
		);
		for (const secret of [
			session?.id,
			"U123",
			"T123",
			"A123",
			"Private Slack Name",
			"slack-user-access",
			"slack-user-refresh",
		])
			assert.ok(secret && !bytes.includes(secret));
	});

	test("Host/path/state validation does not consume a flow; one accepted callback is not replayable", async () => {
		const h = await harness();
		provider(h);
		const opened = deferred<unknown>();
		h.options.openExternal = async (url) => {
			h.opened.push(new URL(url));
			return opened.promise;
		};
		const flow = await begin(h, "slack");
		const query = `code=code&state=${flow.state}`;
		for (const host of [
			"evil.example",
			`127.0.0.1:${new URL(flow.redirect).port}`,
			"localhost",
			`${new URL(flow.redirect).host}.evil`,
		])
			assert.equal((await callback(flow.redirect, query, host)).status, 400);
		for (const query of [
			"code=code&state=wrong",
			`code=code&state=${flow.state}&state=${flow.state}`,
			`code=one&code=two&state=${flow.state}`,
			`code=code&state=${"é".repeat(flow.state.length)}`,
		])
			assert.equal((await callback(flow.redirect, query)).status, 400);
		assert.equal((await callback(flow.redirect, query, undefined, "POST")).status, 404);
		assert.equal((await callback(flow.redirect.replace("/slack/", "/github/"), query)).status, 404);
		assert.equal(h.requests.length, 0);
		assert.equal((await callback(flow.redirect, query)).status, 200);
		assert.equal((await callback(flow.redirect, query)).status, 410);
		opened.resolve(undefined);
		assert.equal((await settled(h))?.phase, "connected");
		assert.equal(h.requests.filter((entry) => entry.url.endsWith("oauth.v2.access")).length, 1);
	});

	test("cancel releases the socket; stale state cannot authorize a new flow on the same port", async () => {
		const h = await harness();
		provider(h);
		const first = await begin(h, "slack");
		await h.service.cancel("slack");
		assert.equal(await h.service.slackCredential(), undefined);
		h.options.callbackPort = Number(new URL(first.redirect).port);
		const second = await begin(h, "slack");
		assert.equal(second.redirect, first.redirect);
		assert.notEqual(first.state, second.state);
		assert.equal((await callback(second.redirect, `code=old&state=${first.state}`)).status, 400);
		assert.equal((await callback(second.redirect, `code=new&state=${second.state}`)).status, 200);
		assert.equal((await settled(h))?.phase, "connected");
		assert.equal(new URLSearchParams(h.requests[0]?.body).get("code"), "new");
	});

	test("matched denial and timeout never exchange credentials", async () => {
		const h = await harness({ timeoutMs: 100 });
		provider(h);
		const flow = await begin(h, "slack");
		assert.equal(
			(await callback(flow.redirect, `error=private-denial&state=${flow.state}`)).status,
			200
		);
		assert.equal((await settled(h))?.error, "denied");
		await begin(h, "slack");
		assert.equal((await settled(h))?.error, "timeout");
		assert.equal(h.requests.length, 0);
		assert.equal(await saved(h), undefined);
	});

	test("absent OAuth returns undefined regardless of a manual token; disconnect preserves app registration", async () => {
		const h = await harness();
		h.manual.slack = "different-manual-account";
		assert.equal(await h.service.slackCredential(), undefined);
		assert.equal(h.requests.length, 0);
		await complete(h, "github");
		await complete(h, "linear");
		await complete(h, "slack");
		const disconnected = await h.service.disconnect("slack");
		assert.equal(disconnected.phase, "disconnected");
		assert.equal(h.manual.slack, undefined);
		assert.equal(await saved(h), undefined);
		assert.equal(await h.service.slackCredential(), undefined);
		assert.equal(await h.service.token("github"), "controlled-gh-access");
		assert.equal(await h.service.token("linear"), "controlled-linear-access");
		assert.equal(h.clients.slack?.clientId, "controlled-slack-client");
		assert.equal((await h.service.status())[2]?.configurationReady, true);
	});

	test("nonrotating localhost grants keep both expiry fields null and do not invent refresh work", async () => {
		const h = await harness();
		const state = provider(h);
		state.grant = {
			...initialGrant,
			authed_user: {
				id: "U123",
				access_token: "nonrotating-user",
				token_type: "user",
				scope: userTokens.scope,
			},
		};
		await complete(h, "slack");
		const session = await saved(h);
		assert.equal(session?.expiresAt, null);
		assert.equal(session?.refreshToken, null);
		assert.equal(session?.refreshExpiresAt, null);
		h.clock.value += 31 * 86400000;
		assert.equal((await h.service.slackCredential())?.accessToken, "nonrotating-user");
		assert.equal(h.requests.length, 3);
	});

	test("single-flight refresh accepts top-level user tokens, preserves saved connection identity and survives restart", async () => {
		const h = await harness();
		const state = provider(h);
		h.clients.slack = {
			clientId: "controlled-slack-client",
			clientSecret: "configured-slack-secret",
		};
		await complete(h, "slack");
		const initial = await saved(h);
		h.clock.value += 43200000 - 60000;
		await h.service.status();
		await h.service.hasCredentials("slack");
		assert.equal(h.requests.length, 3);
		const gate = deferred<void>();
		state.gate = gate.promise;
		const credentials = Promise.all([
			h.service.slackCredential(),
			h.service.slackCredential(),
			h.service.token("slack"),
		]);
		await until(
			async () => h.requests.length,
			(count) => count === 4
		);
		gate.resolve();
		const [first, second, token] = await credentials;
		assert.ok(typeof first !== "string" && first);
		assert.deepEqual(first, second);
		assert.equal(token, "rotated-user-access");
		assert.equal(first.connectionId, initial?.id);
		assert.equal(first.accessToken, token);
		assert.equal(
			h.requests.filter(
				(entry) => new URLSearchParams(entry.body).get("grant_type") === "refresh_token"
			).length,
			1
		);
		const next = await saved(h);
		assert.equal(next?.id, initial?.id);
		assert.deepEqual(next?.slack, initial?.slack);
		assert.equal(next?.refreshToken, "rotated-user-refresh");
		assert.equal(next?.refreshExpiresAt, h.clock.value + 30 * 86400000);
		await h.service.dispose();
		const restarted = new OAuthService(h.options);
		try {
			assert.deepEqual(await restarted.slackCredential(), first);
		} finally {
			await restarted.dispose();
		}
	});

	test("refresh, identity, scope and auth failures retain OAuth and never return another manual account", async () => {
		const h = await harness();
		const state = provider(h);
		h.manual.slack = "different-manual-account";
		await complete(h, "slack");
		const original = await saved(h);
		h.clock.value += 43200000;
		for (const refresh of [
			{ ok: false, error: "private-provider-error" },
			{ ...rotated, token_type: "bot" },
			{ ...rotated, refresh_token: undefined },
			{ ...rotated, id: "U999" },
			{ ...rotated, app_id: "A999" },
			{ ...rotated, team: { id: "T999" } },
			{ ...rotated, scope: "users:read" },
		]) {
			state.refresh = refresh;
			await assert.rejects(h.service.slackCredential(), isError("refresh"));
			assert.deepEqual(await saved(h), original);
			const status = (await h.service.status())[2];
			assert.equal(status?.error, "refresh");
			assert.equal(status?.source, "oauth");
			assert.ok(!JSON.stringify(status).includes("private-provider-error"));
		}
		state.refresh = rotated;
		state.auth = { ok: true, team_id: "T999", user_id: "U123" };
		await assert.rejects(h.service.slackCredential(), isError("refresh"));
		assert.deepEqual(await saved(h), original);
		assert.equal(h.manual.slack, "different-manual-account");
	});

	test("expired refresh token and missing registration fail locally without provider or manual fallback", async () => {
		const h = await harness();
		provider(h);
		await complete(h, "slack");
		const original = await saved(h);
		assert.ok(original);
		const store = new OAuthStore(h.options.directory, h.options.encryption);
		await store.set({
			...original,
			expiresAt: h.clock.value + 30000,
			refreshExpiresAt: h.clock.value - 1,
		});
		await assert.rejects(h.service.slackCredential(), isError("refresh"));
		assert.equal(h.requests.length, 3);
		await store.set({ ...original, expiresAt: h.clock.value + 30000 });
		h.clients.slack = undefined;
		await assert.rejects(h.service.slackCredential(), isError("refresh"));
		assert.equal(h.requests.length, 3);
		await store.set(original);
		// A recorded refresh failure cannot silently produce a previously cached credential.
		await assert.rejects(h.service.slackCredential(), isError("refresh"));
		assert.equal((await h.service.status())[2]?.source, "oauth");
	});

	test("late code exchange and refresh cannot resurrect a disconnected Slack session", async () => {
		for (const refreshing of [false, true]) {
			const h = await harness();
			provider(h);
			if (refreshing) await complete(h, "slack");
			await h.service.dispose();
			const late = deferred<Response>();
			const started = deferred<void>();
			const service = new OAuthService({
				...h.options,
				fetch: (async (input, init) => {
					if (String(input).endsWith("/oauth.v2.access")) {
						started.resolve();
						return late.promise;
					}
					return h.options.fetch?.(input, init) as Promise<Response>;
				}) as typeof fetch,
			});
			try {
				let rejection: Promise<void> | undefined;
				if (refreshing) {
					h.clock.value += 43200000;
					rejection = assert.rejects(service.slackCredential(), isError("cancelled"));
				} else {
					const flow = await begin({ ...h, service }, "slack");
					await callback(flow.redirect, `code=late&state=${flow.state}`);
				}
				await started.promise;
				await service.disconnect("slack");
				await rejection;
				late.resolve(Response.json(refreshing ? rotated : initialGrant));
				assert.equal(await service.slackCredential(), undefined);
				assert.equal(await saved(h), undefined);
			} finally {
				await service.dispose();
			}
		}
	});
});

test("a new Slack login fences an old refresh and creates a new saved connection identity", async () => {
	const h = await harness();
	const state = provider(h);
	await complete(h, "slack");
	const initial = await saved(h);
	await h.service.dispose();
	const late = deferred<Response>();
	const started = deferred<void>();
	const service = new OAuthService({
		...h.options,
		fetch: (async (input, init) => {
			if (new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token") {
				started.resolve();
				return late.promise;
			}
			return h.options.fetch?.(input, init) as Promise<Response>;
		}) as typeof fetch,
	});
	try {
		h.clock.value += 43200000;
		const rejected = assert.rejects(service.slackCredential(), isError("cancelled"));
		await started.promise;
		state.grant = { ...initialGrant, authed_user: { ...initialGrant.authed_user, id: "U456" } };
		state.auth = { ok: true, team_id: "T123", user_id: "U456" };
		state.user = { ok: true, user: { id: "U456", team_id: "T123", name: "new-user" } };
		const flow = await begin({ ...h, service }, "slack");
		await rejected;
		await callback(flow.redirect, `code=new-account&state=${flow.state}`);
		await settled({ ...h, service });
		late.resolve(Response.json(rotated));
		const credential = await service.slackCredential();
		assert.notEqual(credential?.connectionId, initial?.id);
		assert.equal(credential?.userId, "U456");
		assert.equal(credential?.accessToken, "slack-user-access");
		assert.equal((await saved(h))?.account.id, "U456");
	} finally {
		await service.dispose();
	}
});

test("getter rejects stale account epochs and unreadable saved sessions instead of reporting absent OAuth", async () => {
	const port = encryption();
	let duringRead: (() => void) | undefined;
	const h = await harness({
		encryption: {
			...port,
			decryptString(bytes) {
				const action = duringRead;
				duringRead = undefined;
				action?.();
				return port.decryptString(bytes);
			},
		},
	});
	provider(h);
	h.manual.slack = "different-manual-account";
	await complete(h, "slack");
	let cancelled: Promise<unknown> | undefined;
	duringRead = () => {
		cancelled = h.service.cancel("slack");
	};
	await assert.rejects(h.service.slackCredential(), isError("cancelled"));
	await cancelled;
	assert.ok(await h.service.slackCredential());
	h.options.encryption.isEncryptionAvailable = () => false;
	await assert.rejects(h.service.slackCredential(), isError("storage"));
	assert.equal(h.manual.slack, "different-manual-account");
});
