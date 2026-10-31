import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import { OAUTH_MESSAGES, OAuthStatusListSchema } from "../../shared/contracts/oauth";
import { OAuthError } from "./service";
import { begin, complete, deferred, encryption, harness, send, until } from "./test-support";

async function closed(url: string): Promise<void> {
	await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
	const port = Number(new URL(url).port);
	const probe = createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(port, "127.0.0.1", resolve);
	});
	await new Promise<void>((resolve) => probe.close(() => resolve()));
}

describe("standalone OAuth browser flow", () => {
	test("does not open the browser without OS encryption and validates public inputs without echoing them", async () => {
		const h = await harness({
			encryption: { ...encryption(), getSelectedStorageBackend: () => "basic_text" },
		});
		await h.service.start({ provider: "github", requestId: randomUUID() });
		const statuses = await until(
			() => h.service.status(),
			(rows) => rows[0]?.phase === "error"
		);
		assert.equal(statuses[0]?.error, "storage");
		assert.equal(h.opened.length, 0);
		await assert.rejects(
			h.service.start({
				provider: "github",
				requestId: "valid",
				redirectUri: "secret-redirect",
			} as never),
			(error: unknown) =>
				error instanceof OAuthError &&
				error.code === "callback" &&
				!error.message.includes("secret")
		);
		await assert.rejects(
			h.service.cancel("secret-provider" as never),
			(error: unknown) => error instanceof OAuthError && !error.message.includes("secret")
		);
	});
	test("returns promptly, uses GitHub S256/scopes/secret, verifies the actual profile and keeps public status safe", async () => {
		const h = await harness();
		const external = deferred<unknown>();
		h.options.openExternal = async (url) => {
			h.opened.push(new URL(url));
			return external.promise;
		};
		const flow = await begin(h);
		assert.equal(
			flow.authorize.origin + flow.authorize.pathname,
			"https://github.com/login/oauth/authorize"
		);
		assert.equal(
			flow.authorize.searchParams.get("scope"),
			"repo read:user read:org offline_access"
		);
		assert.equal(flow.authorize.searchParams.get("code_challenge_method"), "S256");
		assert.equal(Buffer.from(flow.state, "base64url").length, 32);
		assert.equal(new URL(flow.redirect).hostname, "127.0.0.1");
		assert.equal(new URL(flow.redirect).pathname, "/oauth/github/callback");
		assert.notEqual(new URL(flow.redirect).port, "0");
		const callback = await fetch(`${flow.redirect}?code=controlled-code&state=${flow.state}`);
		const html = await callback.text();
		assert.equal(callback.status, 200);
		assert.equal(callback.headers.get("cache-control"), "no-store");
		assert.ok(!html.includes(flow.state) && !html.includes("controlled-code"));
		assert.equal(h.requests.length, 0);
		external.resolve(undefined);
		const statuses = await until(
			() => h.service.status(),
			(rows) => rows[0]?.phase === "connected"
		);
		OAuthStatusListSchema.parse(statuses);
		assert.deepEqual(
			statuses.map((row) => row.provider),
			["github", "linear", "slack"]
		);
		assert.deepEqual(statuses[0]?.account, {
			id: "123",
			displayName: "Octo User",
			login: "octo",
			avatarUrl: "https://example.test/avatar.png",
		});
		assert.equal(statuses[0]?.source, "oauth");
		assert.equal(statuses[0]?.expiresAt, null);
		assert.equal(await h.service.token("github"), "controlled-gh-access");
		assert.equal(await h.service.authorization("github"), "Bearer controlled-gh-access");
		const exchange = h.requests[0];
		assert.ok(exchange);
		assert.equal(exchange.method, "POST");
		assert.equal(exchange.headers["content-type"], "application/x-www-form-urlencoded");
		const form = new URLSearchParams(exchange.body);
		assert.equal(form.get("client_id"), "controlled-gh-client");
		assert.equal(form.get("client_secret"), "controlled-gh-secret");
		assert.equal(form.get("code"), "controlled-code");
		assert.equal(form.get("redirect_uri"), flow.redirect);
		assert.equal(
			createHash("sha256")
				.update(form.get("code_verifier") ?? "")
				.digest("base64url"),
			flow.authorize.searchParams.get("code_challenge")
		);
		assert.equal(h.requests[1]?.method, "GET");
		assert.equal(h.requests[1]?.url, "https://api.github.com/user");
		assert.equal(h.requests[1]?.headers["authorization"], "Bearer controlled-gh-access");
		for (const secret of [
			"controlled-gh-client",
			"controlled-gh-secret",
			"controlled-gh-access",
			flow.state,
			"controlled-code",
			form.get("code_verifier") ?? "missing",
		])
			assert.ok(!JSON.stringify(statuses).includes(secret));
		assert.deepEqual(h.changes, ["github"]);
		await closed(flow.redirect);
	});

	test("Linear uses user actor, comma scopes, PKCE without a client secret and a Bearer viewer query", async () => {
		const h = await harness();
		const flow = await begin(h, "linear");
		assert.equal(
			flow.authorize.origin + flow.authorize.pathname,
			"https://linear.app/oauth/authorize"
		);
		assert.equal(flow.authorize.searchParams.get("response_type"), "code");
		assert.equal(flow.authorize.searchParams.get("actor"), "user");
		assert.equal(flow.authorize.searchParams.get("scope"), "read,write");
		await (await fetch(`${flow.redirect}?code=linear-code&state=${flow.state}`)).text();
		const statuses = await until(
			() => h.service.status(),
			(rows) => rows[1]?.phase === "connected"
		);
		assert.equal(statuses[1]?.expiresAt, "2026-10-31T12:00:00.000Z");
		assert.deepEqual(statuses[1]?.account, { id: "linear-user", displayName: "Linear User" });
		const form = new URLSearchParams(h.requests[0]?.body);
		assert.equal(form.get("client_secret"), null);
		assert.equal(form.get("grant_type"), "authorization_code");
		assert.equal(
			createHash("sha256")
				.update(form.get("code_verifier") ?? "")
				.digest("base64url"),
			flow.authorize.searchParams.get("code_challenge")
		);
		assert.equal(h.requests[1]?.url, "https://api.linear.app/graphql");
		assert.equal(h.requests[1]?.method, "POST");
		assert.equal(h.requests[1]?.headers["authorization"], "Bearer controlled-linear-access");
		assert.deepEqual(JSON.parse(h.requests[1]?.body ?? "{}"), { query: "{ viewer { id name } }" });
		assert.equal(await h.service.authorization("linear"), "Bearer controlled-linear-access");
		await closed(flow.redirect);
	});

	test("foreign paths/methods, wrong/Unicode/duplicate state, duplicate code and oversized queries do not consume login", async () => {
		const h = await harness();
		const flow = await begin(h);
		const origin = new URL(flow.redirect).origin;
		const rejected = [
			`${origin}/oauth/linear/callback?code=x&state=${flow.state}`,
			`${flow.redirect}/extra?code=x&state=${flow.state}`,
			`${flow.redirect}?code=x&state=wrong`,
			`${flow.redirect}?code=x&state=${encodeURIComponent("é".repeat(flow.state.length))}`,
			`${flow.redirect}?code=x&state=${flow.state}&state=${flow.state}`,
			`${flow.redirect}?code=x&code=y&state=${flow.state}`,
			`${flow.redirect}?error=access_denied&state=wrong`,
			`${flow.redirect}?code=${"x".repeat(2049)}&state=${flow.state}`,
			`${flow.redirect}?code=x&state=${flow.state}&${Array.from({ length: 12 }, (_, i) => `x${i}=a`).join("&")}`,
		];
		for (const url of rejected) {
			const response = await fetch(url);
			assert.ok(response.status >= 400);
			await response.text();
		}
		const post = await fetch(`${flow.redirect}?code=x&state=${flow.state}`, { method: "POST" });
		assert.equal(post.status, 404);
		await post.text();
		assert.equal((await h.service.status())[0]?.phase, "connecting");
		assert.equal(h.requests.length, 0);
		await (await fetch(`${flow.redirect}?code=legitimate&state=${flow.state}`)).text();
		await until(
			() => h.service.status(),
			(rows) => rows[0]?.phase === "connected"
		);
		assert.equal(new URLSearchParams(h.requests[0]?.body).get("code"), "legitimate");
		await closed(flow.redirect);
	});

	test("matched denial is terminal and never exposes provider error details", async () => {
		const h = await harness();
		const flow = await begin(h);
		const response = await fetch(
			`${flow.redirect}?${new URLSearchParams({ state: flow.state, error: "secret-error", error_description: "secret-code" })}`
		);
		assert.ok(!(await response.text()).includes("secret"));
		const statuses = await until(
			() => h.service.status(),
			(rows) => rows[0]?.phase === "error"
		);
		assert.equal(statuses[0]?.error, "denied");
		assert.equal(h.requests.length, 0);
		await closed(flow.redirect);
	});

	test("cancel, timeout, browser failure and shutdown release the callback port", async () => {
		const h = await harness();
		const flow = await begin(h);
		assert.equal((await h.service.cancel("github")).error, "cancelled");
		await closed(flow.redirect);
		const timed = await harness({ timeoutMs: 80 });
		const timeoutFlow = await begin(timed, "linear");
		await until(
			() => timed.service.status(),
			(rows) => rows[1]?.error === "timeout"
		);
		await closed(timeoutFlow.redirect);
		const failed = await harness();
		failed.options.openExternal = async (url) => {
			failed.opened.push(new URL(url));
			throw new Error("raw-secret-open-failure");
		};
		await failed.service.start({ provider: "github", requestId: randomUUID() });
		const statuses = await until(
			() => failed.service.status(),
			(rows) => rows[0]?.phase === "error"
		);
		assert.equal(statuses[0]?.error, "provider");
		assert.ok(!JSON.stringify(statuses).includes("raw-secret"));
		assert.ok(failed.opened[0]);
		await closed(failed.opened[0].searchParams.get("redirect_uri") ?? "");
		const shutdown = await begin(h);
		await h.service.dispose();
		await closed(shutdown.redirect);
		await assert.rejects(
			h.service.start({ provider: "github", requestId: randomUUID() }),
			(error: unknown) => error instanceof OAuthError && error.code === "cancelled"
		);
	});

	test("deduplicates request IDs, holds a process-global flow lock, and reports port collisions safely", async () => {
		const h = await harness();
		const requestId = randomUUID();
		await h.service.start({ provider: "github", requestId });
		await until(
			async () => h.opened.length,
			(n) => n === 1
		);
		await h.service.start({ provider: "github", requestId });
		assert.equal(h.opened.length, 1);
		assert.equal(
			(await h.service.start({ provider: "linear", requestId: randomUUID() })).error,
			"busy"
		);
		const other = await harness();
		assert.equal(
			(await other.service.start({ provider: "linear", requestId: randomUUID() })).error,
			"busy"
		);
		await assert.rejects(h.service.start({ provider: "linear", requestId }), OAuthError);
		const redirect = h.opened[0]?.searchParams.get("redirect_uri");
		assert.ok(redirect);
		await h.service.cancel("github");
		await h.service.start({ provider: "github", requestId });
		assert.equal(h.opened.length, 1); // Replays after cancellation cannot start a new flow.
		const blocker = createServer();
		await new Promise<void>((resolve) =>
			blocker.listen(Number(new URL(redirect).port), "127.0.0.1", resolve)
		);
		try {
			other.options.callbackPort = Number(new URL(redirect).port);
			await other.service.start({ provider: "linear", requestId: randomUUID() });
			const status = await until(
				() => other.service.status(),
				(rows) => rows[1]?.phase === "error"
			);
			assert.equal(status[1]?.error, "callback");
			assert.equal(other.opened.length, 0);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
		await closed(redirect);
	});

	test("GitHub requires a secret, Linear requires rotated refresh data, and invalid profiles never persist", async () => {
		const h = await harness();
		h.clients.github = { clientId: "gh-without-secret" };
		await h.service.start({ provider: "github", requestId: randomUUID() });
		await until(
			() => h.service.status(),
			(rows) => rows[0]?.error === "unconfigured"
		);
		assert.equal(h.opened.length, 0);
		h.setHandler((_request, response) =>
			send(response, { access_token: "would-be-token", token_type: "Bearer", expires_in: 86400 })
		);
		assert.equal((await complete(h, "linear")).error, "provider");
		assert.equal(await h.service.hasCredentials("linear"), false);
		h.clients.github = { clientId: "client", clientSecret: "secret" };
		h.setHandler((request, response) =>
			request.url.endsWith("access_token")
				? send(response, { access_token: "must-not-persist", token_type: "bearer" })
				: send(response, { message: "raw-secret-profile-error" }, 401)
		);
		assert.equal((await complete(h)).error, "provider");
		assert.equal(await h.service.hasCredentials("github"), false);
		assert.ok(!JSON.stringify(await h.service.status()).includes("must-not-persist"));
	});

	test("bounded HTTP/JSON failures and redirects expose only fixed errors", async () => {
		const h = await harness();
		for (const failure of [
			"status",
			"redirect",
			"large",
			"bad-json",
			"invalid-type",
			"token-error",
			"header-token",
		]) {
			h.setHandler((_request, response) => {
				if (failure === "status") send(response, { error: "raw-client-secret" }, 500);
				else if (failure === "redirect") {
					response.writeHead(302, { Location: "http://127.0.0.1:1/secret" });
					response.end();
				} else if (failure === "large") send(response, { padding: "s".repeat(70000) });
				else if (failure === "bad-json") {
					response.writeHead(200, { "Content-Type": "application/json" });
					response.end("{raw-secret");
				} else if (failure === "invalid-type") {
					response.writeHead(200, { "Content-Type": "text/html" });
					response.end("secret");
				} else if (failure === "header-token")
					send(response, { access_token: "token\r\nInjected: secret", token_type: "bearer" });
				else send(response, { error: "raw-secret", error_description: "raw-secret" });
			});
			const result = await complete(h);
			assert.equal(result.error, "provider", failure);
			assert.ok(!JSON.stringify(result).includes("raw-secret"));
			assert.equal(await h.service.hasCredentials("github"), false);
		}
		const error = new OAuthError("provider");
		assert.equal(error.message, OAUTH_MESSAGES.provider);
		assert.equal(error.cause, undefined);
	});

	test("manual fallback/header compatibility, OAuth-only clear and provider-only logout preserve configuration", async () => {
		const h = await harness();
		h.manual.github = "manual-gh";
		h.manual.linear = "manual-linear";
		assert.equal(await h.service.token("github"), "manual-gh");
		assert.equal(await h.service.authorization("linear"), "manual-linear");
		assert.equal((await h.service.status())[1]?.source, "env");
		await complete(h, "github");
		await complete(h, "linear");
		assert.equal(await h.service.authorization("linear"), "Bearer controlled-linear-access");
		await h.service.clearSession("github");
		assert.equal(await h.service.token("github"), "manual-gh");
		assert.equal(h.manual.github, "manual-gh");
		await h.service.disconnect("linear");
		assert.equal(await h.service.hasCredentials("linear"), false);
		assert.equal(h.manual.linear, undefined);
		assert.equal(await h.service.hasCredentials("github"), true);
		assert.equal((await h.service.status())[1]?.configurationReady, true);
		assert.equal(h.clients.linear?.clientId, "controlled-linear-client");
		assert.deepEqual(h.changes, ["github", "linear", "github", "linear"]);
	});

	test("onChange data-refresh failures never turn a successful saved login or logout into failure", async () => {
		const h = await harness({
			onChange: async () => {
				throw new Error("hub-refresh-secret");
			},
		});
		assert.equal((await complete(h)).phase, "connected");
		assert.equal(await h.service.token("github"), "controlled-gh-access");
		assert.equal((await h.service.disconnect("github")).phase, "disconnected");
	});

	test("cancellation at setup and hung browser/provider operations is abortable", async () => {
		const h = await harness();
		const config = deferred<undefined>();
		let first = true;
		h.options.getClient = async (provider) => {
			if (first) {
				first = false;
				return config.promise;
			}
			return h.clients[provider];
		};
		await h.service.start({ provider: "github", requestId: randomUUID() });
		await h.service.cancel("github");
		config.resolve(undefined);
		assert.equal(h.opened.length, 0);
		const external = deferred<unknown>();
		h.options.openExternal = async (url) => {
			h.opened.push(new URL(url));
			return external.promise;
		};
		const flow = await begin(h);
		await h.service.cancel("github");
		await closed(flow.redirect);
		external.resolve(undefined);
		const late = deferred<Response>();
		const network = await harness({ fetch: (async () => late.promise) as typeof fetch });
		const callback = await begin(network);
		await (await fetch(`${callback.redirect}?code=late&state=${callback.state}`)).text();
		await network.service.disconnect("github");
		late.resolve(Response.json({ access_token: "late-token", token_type: "bearer" }));
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(await network.service.hasCredentials("github"), false);
		await closed(callback.redirect);
	});
});
