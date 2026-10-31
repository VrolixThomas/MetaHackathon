import assert from "node:assert/strict";
import { test } from "node:test";
import {
	SLACK_USER_SCOPES,
	exchangeSlackCode,
	refreshSlackToken,
	slackAuthorizationUrl,
	slackProfile,
} from "./oauth";
import { SlackError } from "./types";

const client = { clientId: "controlled-client", clientSecret: "controlled-secret" };
const redirectUri = "http://localhost:43187/oauth/slack/callback";
function fetcher(body: unknown, check?: (init: RequestInit) => void): typeof fetch {
	return (async (input, init) => {
		assert.equal(String(input), "https://slack.com/api/oauth.v2.access");
		assert.equal(init?.redirect, "error");
		assert.equal(init?.method, "POST");
		assert.equal(
			new Headers(init?.headers).get("content-type"),
			"application/x-www-form-urlencoded"
		);
		assert.equal(new Headers(init?.headers).get("authorization"), null);
		const form = new URLSearchParams(String(init?.body));
		assert.equal(form.get("client_id"), client.clientId);
		assert.equal(form.get("client_secret"), null);
		assert.ok(!JSON.stringify(init).includes(client.clientSecret));
		check?.(init ?? {});
		return Response.json(body);
	}) as typeof fetch;
}
const user = {
	id: "U123",
	access_token: "user-secret",
	token_type: "user",
	scope: "im:read,im:history,chat:write",
};
const grant = {
	ok: true,
	app_id: "A123",
	team: { id: "T123" },
	authed_user: user,
	access_token: "bot-secret",
	token_type: "bot",
};

test("Slack desktop URL requests user scopes and S256 with a localhost redirect", () => {
	const url = new URL(
		slackAuthorizationUrl({
			clientId: client.clientId,
			redirectUri,
			state: "one-time-state",
			challenge: "challenge",
		})
	);
	assert.equal(url.origin, "https://slack.com");
	assert.equal(url.searchParams.get("user_scope"), SLACK_USER_SCOPES.join(","));
	assert.equal(url.searchParams.get("scope"), null);
	assert.equal(url.searchParams.get("state"), "one-time-state");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	for (const invalid of [
		"http://127.0.0.1:43187/oauth/slack/callback",
		"http://localhost.evil:43187/oauth/slack/callback",
		"http://localhost:43187/wrong-path",
		`${redirectUri}?unexpected=query`,
		"https://user:pass@muse.example/cb",
		`${redirectUri}#fragment`,
	])
		assert.throws(
			() =>
				slackAuthorizationUrl({
					clientId: "client",
					redirectUri: invalid,
					state: "state",
					challenge: "challenge",
				}),
			SlackError
		);
});

test("code exchange selects nested user grant and never substitutes a bot token", async () => {
	const result = await exchangeSlackCode({
		client,
		code: "code",
		redirectUri,
		verifier: "verifier",
		now: 0,
		fetch: fetcher(grant, (init) => {
			const fields = new URLSearchParams(String(init.body));
			assert.equal(fields.get("code"), "code");
			assert.equal(fields.get("redirect_uri"), redirectUri);
			assert.equal(fields.get("code_verifier"), "verifier");
			assert.equal(fields.get("client_secret"), null);
		}),
	});
	assert.deepEqual(result, {
		appId: "A123",
		workspaceId: "T123",
		userId: "U123",
		accessToken: "user-secret",
		scopes: ["im:read", "im:history", "chat:write"],
		refreshToken: null,
		expiresAt: null,
		refreshExpiresAt: null,
	});
	for (const bad of [
		{ ...grant, authed_user: undefined },
		{ ...grant, authed_user: { ...user, token_type: "bot" } },
	])
		await assert.rejects(
			exchangeSlackCode({
				client,
				code: "code",
				redirectUri,
				verifier: "verifier",
				fetch: fetcher(bad),
			}),
			SlackError
		);
});

test("rotation retains user/workspace identity and returns replacement single-use refresh token", async () => {
	const previous = await exchangeSlackCode({
		client,
		code: "code",
		redirectUri,
		verifier: "verifier",
		now: 1000,
		fetch: fetcher({
			...grant,
			authed_user: { ...user, expires_in: 43200, refresh_token: "first-refresh" },
		}),
	});
	assert.equal(previous.expiresAt, 43_201_000);
	assert.equal(previous.refreshExpiresAt, 1000 + 30 * 86400000);
	const next = await refreshSlackToken({
		client,
		previous,
		now: 2000,
		fetch: fetcher(
			{
				ok: true,
				token_type: "user",
				access_token: "new-user",
				refresh_token: "second-refresh",
				expires_in: 43200,
				scope: user.scope,
			},
			(init) => {
				const fields = new URLSearchParams(String(init.body));
				assert.equal(fields.get("grant_type"), "refresh_token");
				assert.equal(fields.get("refresh_token"), "first-refresh");
			}
		),
	});
	assert.equal(next.userId, "U123");
	assert.equal(next.workspaceId, "T123");
	assert.equal(next.refreshToken, "second-refresh");
	assert.equal(next.expiresAt, 43_202_000);
	assert.equal(next.refreshExpiresAt, 2000 + 30 * 86400000);
	await assert.rejects(
		refreshSlackToken({
			client,
			previous,
			fetch: fetcher({ ok: true, token_type: "bot", access_token: "bot", scope: "chat:write" }),
		}),
		SlackError
	);
});

test("provider errors, malformed and oversized bodies never expose credentials or provider text", async () => {
	for (const body of [
		{ ok: false, error: "controlled-secret" },
		{ ...grant, authed_user: { ...user, expires_in: 43200 } },
		{ ...grant, ignored: "x".repeat(70000) },
	]) {
		await assert.rejects(
			exchangeSlackCode({
				client,
				code: "code",
				redirectUri,
				verifier: "verifier",
				fetch: fetcher(body),
			}),
			(error: unknown) =>
				error instanceof SlackError && !error.message.includes("controlled-secret")
		);
	}
});

test("profile verifies actual user/workspace before exposing bounded display metadata", async () => {
	const controlledGrant = await exchangeSlackCode({
		client,
		code: "code",
		redirectUri,
		verifier: "verifier",
		fetch: fetcher(grant),
	});
	const requests: string[] = [];
	const account = await slackProfile({
		grant: controlledGrant,
		fetch: (async (input, init) => {
			const method = new URL(String(input)).pathname;
			assert.equal(
				new Headers(init?.headers).get("content-type"),
				"application/x-www-form-urlencoded"
			);
			if (method.endsWith("users.info"))
				assert.equal(new URLSearchParams(String(init?.body)).get("user"), "U123");
			requests.push(method);
			return Response.json(
				method.endsWith("auth.test")
					? { ok: true, team_id: "T123", user_id: "U123" }
					: {
							ok: true,
							user: {
								id: "U123",
								team_id: "T123",
								name: "viewer",
								profile: { real_name: "Real User" },
							},
						}
			);
		}) as typeof fetch,
	});
	assert.deepEqual(account, { id: "U123", displayName: "Real User", login: "viewer" });
	assert.deepEqual(requests, ["/api/auth.test", "/api/users.info"]);
	await assert.rejects(
		slackProfile({
			grant: controlledGrant,
			fetch: (async () =>
				Response.json({ ok: true, team_id: "T999", user_id: "U123" })) as typeof fetch,
		}),
		SlackError
	);
});

test("public client works with no secret and PKCE arguments cannot be omitted", async () => {
	await exchangeSlackCode({
		client: { clientId: client.clientId },
		code: "code",
		redirectUri,
		verifier: "verifier",
		fetch: fetcher(grant),
	});
	assert.throws(
		() =>
			slackAuthorizationUrl({
				clientId: client.clientId,
				redirectUri,
				state: "state",
				challenge: undefined as never,
			}),
		SlackError
	);
	await assert.rejects(
		exchangeSlackCode({
			client,
			code: "code",
			redirectUri,
			verifier: undefined as never,
			fetch: fetcher(grant),
		}),
		SlackError
	);
});

test("nested refresh grants preserve identity and scope ordering; changed scopes or identities reject", async () => {
	const previous = await exchangeSlackCode({
		client,
		code: "code",
		redirectUri,
		verifier: "verifier",
		fetch: fetcher({
			...grant,
			authed_user: { ...user, expires_in: 43200, refresh_token: "refresh" },
		}),
	});
	const nextUser = {
		...user,
		access_token: "new-user",
		refresh_token: "next-refresh",
		expires_in: 43200,
		scope: "chat:write,im:history,im:read",
	};
	const next = await refreshSlackToken({
		client,
		previous,
		fetch: fetcher({ ...grant, authed_user: nextUser }),
	});
	assert.equal(next.accessToken, "new-user");
	assert.deepEqual(next.scopes, previous.scopes);
	for (const authed_user of [
		{ ...nextUser, id: "U999" },
		{ ...nextUser, token_type: "bot" },
		{ ...nextUser, scope: "im:read" },
	])
		await assert.rejects(
			refreshSlackToken({ client, previous, fetch: fetcher({ ...grant, authed_user }) }),
			SlackError
		);
});

test("auth.test and users.info cannot confirm a foreign, bot, deleted or revoked account", async () => {
	for (const [identity, info] of [
		[{ ok: true, team_id: "T123", user_id: "U999" }, {}],
		[{ ok: true, team_id: "T123", user_id: "U123", bot_id: "B123" }, {}],
		[{ ok: false, error: "token_revoked" }, {}],
		[{ ok: true, team_id: "T123", user_id: "U123" }, { id: "U999" }],
		[
			{ ok: true, team_id: "T123", user_id: "U123" },
			{ id: "U123", team_id: "T999" },
		],
		[
			{ ok: true, team_id: "T123", user_id: "U123" },
			{ id: "U123", is_bot: true },
		],
		[
			{ ok: true, team_id: "T123", user_id: "U123" },
			{ id: "U123", deleted: true },
		],
	]) {
		await assert.rejects(
			slackProfile({
				grant: { workspaceId: "T123", userId: "U123", accessToken: "token" },
				fetch: (async (input) =>
					Response.json(
						String(input).endsWith("auth.test") ? identity : { ok: true, user: info }
					)) as typeof fetch,
			}),
			SlackError
		);
	}
});

test("nullish optional profile names fall back without weakening verified user identity", async () => {
	for (const [profile, name, displayName] of [
		[{ real_name: null, display_name: "Display Name" }, "viewer", "Display Name"],
		[{ real_name: "Real Name", display_name: null }, "viewer", "Real Name"],
		[{ real_name: null, display_name: null }, "viewer", "viewer"],
		[{ real_name: "", display_name: null }, undefined, "U123"],
		[{}, undefined, "U123"],
	] as const) {
		const account = await slackProfile({
			grant: { accessToken: "controlled-token", userId: "U123", workspaceId: "T123" },
			fetch: (async (input, init) => {
				assert.equal(
					new Headers(init?.headers).get("content-type"),
					"application/x-www-form-urlencoded"
				);
				if (String(input).endsWith("auth.test"))
					return Response.json({ ok: true, team_id: "T123", user_id: "U123" });
				assert.equal(new URLSearchParams(String(init?.body)).get("user"), "U123");
				return Response.json({ ok: true, user: { id: "U123", team_id: "T123", name, profile } });
			}) as typeof fetch,
		});
		assert.deepEqual(account, { id: "U123", displayName, ...(name ? { login: name } : {}) });
	}
});
