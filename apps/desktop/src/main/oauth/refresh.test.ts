import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OAuthError, OAuthService } from "./service";
import { OAuthStore } from "./store";
import { begin, complete, deferred, encryption, harness, send, until } from "./test-support";

describe("refresh rotation and generation fences", () => {
	test("presence never refreshes; early concurrent refresh is deduplicated, rotated atomically and durable", async () => {
		const h = await harness();
		await complete(h, "linear");
		const store = new OAuthStore(h.options.directory, h.options.encryption);
		const initial = await store.get("linear");
		assert.ok(initial);
		h.clock.value += 86400000 - 60000;
		assert.equal(await h.service.hasCredentials("linear"), true);
		await h.service.status();
		assert.equal(h.requests.length, 2);
		const gate = deferred<void>();
		h.setHandler(async (request, response) => {
			const form = new URLSearchParams(request.body);
			assert.equal(form.get("grant_type"), "refresh_token");
			assert.equal(form.get("refresh_token"), "controlled-linear-refresh");
			assert.equal(form.get("client_id"), "controlled-linear-client");
			assert.equal(form.get("client_secret"), null);
			await gate.promise;
			send(response, {
				access_token: "rotated-access",
				refresh_token: "rotated-refresh",
				token_type: "Bearer",
				expires_in: 86400,
				scope: ["read", "write"],
			});
		});
		const tokens = Promise.all([
			h.service.token("linear"),
			h.service.token("linear"),
			h.service.authorization("linear"),
		]);
		await until(
			async () => h.requests.length,
			(n) => n === 3
		);
		gate.resolve();
		assert.deepEqual(await tokens, ["rotated-access", "rotated-access", "Bearer rotated-access"]);
		assert.equal(h.requests.length, 3);
		const rotated = await store.get("linear");
		assert.ok(rotated);
		assert.equal(rotated.id, initial.id);
		assert.equal(rotated.accessToken, "rotated-access");
		assert.equal(rotated.refreshToken, "rotated-refresh");
		assert.equal(rotated.expiresAt, h.clock.value + 86400000);
		await h.service.dispose();
		const restarted = new OAuthService(h.options);
		try {
			assert.equal(await restarted.token("linear"), "rotated-access");
			assert.equal((await restarted.status())[1]?.account?.id, "linear-user");
		} finally {
			await restarted.dispose();
		}
	});

	test("GitHub supports optional expiring/refresh fields and requires the client secret on refresh", async () => {
		const h = await harness();
		let refreshed = false;
		h.setHandler((request, response) => {
			if (request.url === "https://api.github.com/user") {
				send(response, { id: 789, login: "expiring" });
				return;
			}
			const form = new URLSearchParams(request.body);
			if (form.get("grant_type") === "refresh_token") {
				refreshed = true;
				assert.equal(form.get("client_secret"), "controlled-gh-secret");
				assert.equal(form.get("refresh_token"), "gh-refresh-old");
				send(response, {
					access_token: "gh-new",
					refresh_token: "gh-refresh-new",
					expires_in: 28800,
					refresh_token_expires_in: 15552000,
					token_type: "bearer",
					scope: "repo read:user read:org",
				});
			} else
				send(response, {
					access_token: "gh-old",
					refresh_token: "gh-refresh-old",
					expires_in: 120,
					refresh_token_expires_in: 15552000,
					token_type: "bearer",
					scope: "repo,read:user,read:org",
				});
		});
		const status = await complete(h);
		assert.equal(status.account?.displayName, "expiring");
		assert.equal(status.expiresAt, "2026-10-30T12:02:00.000Z");
		h.clock.value += 60000;
		assert.equal(await h.service.token("github"), "gh-new");
		assert.equal(refreshed, true);
		const saved = await new OAuthStore(h.options.directory, h.options.encryption).get("github");
		assert.equal(saved?.refreshToken, "gh-refresh-new");
		assert.equal(saved?.refreshExpiresAt, h.clock.value + 15552000000);
	});

	test("refresh failure never falls back to a different manual account and retains the encrypted session", async () => {
		const h = await harness();
		h.manual.linear = "other-account-pat";
		await complete(h, "linear");
		h.clock.value += 86400000;
		h.setHandler((_request, response) => send(response, { error: "refresh-secret-code" }, 401));
		await assert.rejects(
			h.service.token("linear"),
			(error: unknown) =>
				error instanceof OAuthError && error.code === "refresh" && !error.message.includes("secret")
		);
		assert.equal(await h.service.hasCredentials("linear"), true);
		const status = (await h.service.status())[1];
		assert.equal(status?.error, "refresh");
		assert.equal(status?.source, "oauth");
		assert.equal(status?.account?.id, "linear-user");
		await h.service.clearSession("linear");
		assert.equal(await h.service.authorization("linear"), "other-account-pat");
	});

	test("late refresh cannot resurrect a disconnected credential even when fetch ignores abort", async () => {
		const late = deferred<Response>();
		const started = deferred<void>();
		let refreshing = false;
		const h = await harness();
		await complete(h, "linear");
		await h.service.dispose();
		const service = new OAuthService({
			...h.options,
			fetch: (async (input, init) => {
				if (new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token") {
					refreshing = true;
					started.resolve();
					return late.promise;
				}
				return h.options.fetch?.(input, init) as Promise<Response>;
			}) as typeof fetch,
		});
		try {
			h.clock.value += 86400000;
			const token = service.token("linear");
			const rejected = assert.rejects(
				token,
				(error: unknown) => error instanceof OAuthError && error.code === "cancelled"
			);
			await started.promise;
			assert.equal(refreshing, true);
			await service.disconnect("linear");
			await rejected;
			late.resolve(
				Response.json({
					access_token: "late-resurrect",
					refresh_token: "late-refresh",
					token_type: "Bearer",
					expires_in: 86400,
				})
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(await service.hasCredentials("linear"), false);
			assert.equal(
				await new OAuthStore(h.options.directory, h.options.encryption).get("linear"),
				undefined
			);
		} finally {
			await service.dispose();
		}
	});

	test("new login fences old refresh; out-of-order response cannot replace the new account or its tokens", async () => {
		const late = deferred<Response>();
		const started = deferred<void>();
		const h = await harness();
		await complete(h, "linear");
		await h.service.dispose();
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
			h.clock.value += 86400000;
			const previous = (
				await new OAuthStore(h.options.directory, h.options.encryption).get("linear")
			)?.id;
			const token = service.token("linear");
			const rejected = assert.rejects(
				token,
				(error: unknown) => error instanceof OAuthError && error.code === "cancelled"
			);
			await started.promise;
			h.setHandler((request, response) =>
				request.url.endsWith("/oauth/token")
					? send(response, {
							access_token: "new-account-access",
							refresh_token: "new-account-refresh",
							token_type: "Bearer",
							expires_in: 86400,
							scope: "read write",
						})
					: send(response, { data: { viewer: { id: "new-account", name: "New Account" } } })
			);
			const flow = await begin({ ...h, service }, "linear");
			await rejected;
			await (await fetch(`${flow.redirect}?code=new-account-code&state=${flow.state}`)).text();
			await until(
				() => service.status(),
				(rows) => rows[1]?.account?.id === "new-account" && rows[1].phase === "connected"
			);
			late.resolve(
				Response.json({
					access_token: "stale-account-access",
					refresh_token: "stale-account-refresh",
					token_type: "Bearer",
					expires_in: 86400,
				})
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			const current = await new OAuthStore(h.options.directory, h.options.encryption).get("linear");
			assert.notEqual(current?.id, previous);
			assert.equal(current?.account.id, "new-account");
			assert.equal(await service.token("linear"), "new-account-access");
			await service.disconnect("linear");
		} finally {
			await service.dispose();
		}
	});

	test("expired refresh tokens and missing current app credentials fail locally without manual fallback", async () => {
		const h = await harness();
		await complete(h, "linear");
		const store = new OAuthStore(h.options.directory, h.options.encryption);
		const session = await store.get("linear");
		assert.ok(session);
		await store.set({
			...session,
			expiresAt: h.clock.value + 30000,
			refreshExpiresAt: h.clock.value - 1,
		});
		await assert.rejects(h.service.token("linear"), OAuthError);
		assert.equal(h.requests.length, 2);
		await store.set({ ...session, expiresAt: h.clock.value + 30000 });
		h.clients.linear = undefined;
		await assert.rejects(h.service.token("linear"), OAuthError);
		assert.equal(h.requests.length, 2);
	});

	test("cancel during an encrypted login write restores the previously accepted account", async () => {
		const port = encryption();
		let duringWrite: (() => void) | undefined;
		const h = await harness({
			encryption: {
				...port,
				encryptString(value) {
					const action = duringWrite;
					duringWrite = undefined;
					action?.();
					return port.encryptString(value);
				},
			},
		});
		await complete(h);
		const store = new OAuthStore(h.options.directory, h.options.encryption);
		const before = await store.get("github");
		h.setHandler((request, response) =>
			request.url.endsWith("access_token")
				? send(response, { access_token: "cancelled-new-account", token_type: "bearer" })
				: send(response, { id: 999, login: "cancelled-account" })
		);
		let cancelled: Promise<unknown> | undefined;
		duringWrite = () => {
			cancelled = h.service.cancel("github");
		};
		const result = await complete(h);
		await cancelled;
		assert.equal(result.error, "cancelled");
		assert.deepEqual(await store.get("github"), before);
		assert.equal(await h.service.token("github"), "controlled-gh-access");
	});

	test("disconnect during an encrypted refresh write cannot resurrect the session", async () => {
		const port = encryption();
		let duringWrite: (() => void) | undefined;
		const h = await harness({
			encryption: {
				...port,
				encryptString(value) {
					const action = duringWrite;
					duringWrite = undefined;
					action?.();
					return port.encryptString(value);
				},
			},
		});
		await complete(h, "linear");
		h.clock.value += 86400000;
		h.setHandler((_request, response) =>
			send(response, {
				access_token: "write-race-access",
				refresh_token: "write-race-refresh",
				token_type: "Bearer",
				expires_in: 86400,
			})
		);
		let disconnected: Promise<unknown> | undefined;
		duringWrite = () => {
			disconnected = h.service.disconnect("linear");
		};
		await assert.rejects(
			h.service.token("linear"),
			(error: unknown) => error instanceof OAuthError && error.code === "cancelled"
		);
		await disconnected;
		assert.equal(await h.service.hasCredentials("linear"), false);
	});

	test("dispose aborts a hung refresh and retains the last complete durable session", async () => {
		const late = deferred<Response>();
		const started = deferred<void>();
		const h = await harness();
		await complete(h, "linear");
		await h.service.dispose();
		const before = await new OAuthStore(h.options.directory, h.options.encryption).get("linear");
		const service = new OAuthService({
			...h.options,
			fetch: (async () => {
				started.resolve();
				return late.promise;
			}) as typeof fetch,
		});
		h.clock.value += 86400000;
		const token = service.token("linear");
		const rejected = assert.rejects(
			token,
			(error: unknown) => error instanceof OAuthError && error.code === "cancelled"
		);
		await started.promise;
		await service.dispose();
		await rejected;
		late.resolve(
			Response.json({
				access_token: "late-disposed",
				refresh_token: "late-refresh",
				token_type: "Bearer",
				expires_in: 86400,
			})
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(
			await new OAuthStore(h.options.directory, h.options.encryption).get("linear"),
			before
		);
	});
});
