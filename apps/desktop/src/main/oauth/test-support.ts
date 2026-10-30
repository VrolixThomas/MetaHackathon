import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import type { OAuthProvider, OAuthStatus } from "../../shared/contracts/oauth";
import type { SecretEncryption } from "../runtime/credentials";
import { OAuthService } from "./service";
import type { OAuthClient, OAuthServiceOptions } from "./types";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function encryption(): SecretEncryption {
	const key = randomBytes(32);
	return {
		isEncryptionAvailable: () => true,
		encryptString(value) {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
			return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
		},
		decryptString(value) {
			const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
			cipher.setAuthTag(value.subarray(12, 28));
			return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
		},
	};
}

export async function directory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "met-53-oauth-"));
	cleanups.push(() => rm(path, { recursive: true, force: true }));
	return path;
}

export function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export async function until<T>(
	read: () => Promise<T>,
	accepted: (value: T) => boolean
): Promise<T> {
	const deadline = Date.now() + 3000;
	while (true) {
		const value = await read();
		if (accepted(value)) return value;
		assert.ok(Date.now() < deadline, `Timed out waiting: ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export interface ProviderRequest {
	url: string;
	method: string;
	headers: IncomingMessage["headers"];
	body: string;
}

export function send(response: ServerResponse, body: unknown, status = 200): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(body));
}

export async function harness(overrides: Partial<OAuthServiceOptions> = {}) {
	const requests: ProviderRequest[] = [];
	const opened: URL[] = [];
	const manual: Partial<Record<OAuthProvider, string>> = {};
	const clients: Partial<Record<OAuthProvider, OAuthClient>> = {
		github: { clientId: "controlled-gh-client", clientSecret: "controlled-gh-secret" },
		linear: { clientId: "controlled-linear-client" },
	};
	const changes: OAuthProvider[] = [];
	const clock = { value: Date.parse("2026-10-30T12:00:00Z") };
	let handler:
		| ((request: ProviderRequest, response: ServerResponse) => void | Promise<void>)
		| undefined;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const entry = {
			url: decodeURIComponent((request.url ?? "").slice(1)),
			method: request.method ?? "",
			headers: request.headers,
			body: Buffer.concat(chunks).toString(),
		};
		requests.push(entry);
		if (handler) {
			await handler(entry, response);
			return;
		}
		if (entry.url === "https://github.com/login/oauth/access_token")
			send(response, {
				access_token: "controlled-gh-access",
				token_type: "bearer",
				scope: "repo,read:user,read:org",
			});
		else if (entry.url === "https://api.linear.app/oauth/token")
			send(response, {
				access_token: "controlled-linear-access",
				refresh_token: "controlled-linear-refresh",
				expires_in: 86400,
				token_type: "Bearer",
				scope: "read write",
			});
		else if (entry.url === "https://api.github.com/user")
			send(response, {
				id: 123,
				login: "octo",
				name: "Octo User",
				avatar_url: "https://example.test/avatar.png",
			});
		else if (entry.url === "https://api.linear.app/graphql")
			send(response, { data: { viewer: { id: "linear-user", name: "Linear User" } } });
		else send(response, {}, 404);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			})
	);
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	const options: OAuthServiceOptions = {
		directory: await directory(),
		encryption: encryption(),
		callbackPort: 0,
		getClient: async (provider) => clients[provider],
		getManualToken: async (provider) => manual[provider],
		clearManualToken: async (provider) => {
			delete manual[provider];
		},
		openExternal: async (url) => {
			opened.push(new URL(url));
		},
		onChange: async (provider) => {
			changes.push(provider);
		},
		fetch: (async (input, init) => {
			assert.equal(init?.redirect, "error");
			return fetch(`${origin}/${encodeURIComponent(String(input))}`, init);
		}) as typeof fetch,
		now: () => clock.value,
		...overrides,
	};
	const service = new OAuthService(options);
	cleanups.push(() => service.dispose());
	return {
		service,
		options,
		requests,
		opened,
		manual,
		clients,
		changes,
		clock,
		setHandler: (next: typeof handler) => {
			handler = next;
		},
	};
}

export async function begin(
	h: Awaited<ReturnType<typeof harness>>,
	provider: OAuthProvider = "github"
) {
	const count = h.opened.length;
	const initial = await h.service.start({ provider, requestId: randomUUID() });
	assert.equal(initial.phase, "connecting");
	await until(
		async () => h.opened.length,
		(length) => length === count + 1
	);
	const authorize = h.opened[count];
	assert.ok(authorize);
	const redirect = authorize.searchParams.get("redirect_uri");
	const state = authorize.searchParams.get("state");
	assert.ok(redirect && state);
	return { authorize, redirect, state };
}

export async function complete(
	h: Awaited<ReturnType<typeof harness>>,
	provider: OAuthProvider = "github"
): Promise<OAuthStatus> {
	const { redirect, state } = await begin(h, provider);
	const response = await fetch(
		`${redirect}?${new URLSearchParams({ code: "controlled-code", state })}`
	);
	assert.equal(response.status, 200);
	await response.text();
	return until(
		async () => (await h.service.status()).find((row) => row.provider === provider) as OAuthStatus,
		(row) => row.phase !== "connecting"
	);
}
