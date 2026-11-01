import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { sha256 } from "../protocol";
import { createTeamApiHandler } from "./api";
import { edgeConfiguration } from "./config";
import { EDGE_MAX_RUN_MS, scopedFetch } from "./http";
import { createTeamWebhookHandler } from "./webhook";
import { type WorkerPorts, createTeamWorkerHandler } from "./worker";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = {
	SUPABASE_URL: "https://db.example",
	SUPABASE_ANON_KEY: "controlled-public-key",
	SUPABASE_SERVICE_ROLE_KEY: "controlled-server-only-key",
	GITHUB_APP_ID: "123",
	GITHUB_APP_PRIVATE_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	TEAM_ANALYSIS_VERSION: "controlled-v1",
	GITHUB_WEBHOOK_SECRET: "controlled-webhook-only-secret",
	TEAM_WORKER_INVOKE_SECRET: "controlled-worker-invoke-only-secret-0123456789",
	MODEL_API_KEY: "controlled-server-model-key",
};
const org = "10000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000001";
const repository = {
	org_id: org,
	repository_id: "42",
	full_name: "test/repo",
	installation_id: "7",
	enabled: true,
};
const apiHeaders = { Authorization: "Bearer user-jwt", "x-github-token": "user-github" };
const workerHeaders = {
	Authorization: `Bearer ${env.TEAM_WORKER_INVOKE_SECRET}`,
	"Content-Type": "application/json",
};
const neverFetch = (async () => {
	assert.fail("Unexpected external transport call");
}) as typeof fetch;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function workerRequest(body: unknown = { queue: "webhook" }, headers: HeadersInit = workerHeaders) {
	return new Request("https://edge.example/functions/v1/muse-team-worker", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}
function signedRequest(raw: string, signatureRaw = raw) {
	return new Request("https://edge.example/muse-team-webhook", {
		method: "POST",
		headers: {
			"x-hub-signature-256": `sha256=${createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(signatureRaw).digest("hex")}`,
			"x-github-event": "pull_request",
			"x-github-delivery": "00000000-0000-4000-8000-000000000009",
		},
		body: raw,
	});
}

test("API strips only exact function prefixes and revalidates both identities on every request", async () => {
	let authReads = 0;
	let githubReads = 0;
	let mismatch = false;
	const transport = (async (raw: unknown, init?: RequestInit) => {
		const url = new URL(String(raw));
		const auth = new Headers(init?.headers).get("authorization");
		if (url.pathname === "/auth/v1/user") {
			authReads++;
			assert.equal(auth, "Bearer user-jwt");
			return Response.json({
				id: user,
				identities: [{ provider: "github", identity_data: { sub: "101" } }],
			});
		}
		if (url.hostname === "api.github.com" && url.pathname === "/user") {
			githubReads++;
			assert.equal(auth, "Bearer user-github");
			return Response.json({ id: mismatch ? 102 : 101, login: "reader" });
		}
		if (url.pathname === "/rest/v1/team_organizations") {
			assert.equal(auth, "Bearer user-jwt");
			return Response.json([{ id: org, name: "Actual controlled org" }]);
		}
		assert.fail(`Unexpected controlled path ${url.pathname}`);
	}) as typeof fetch;
	const handler = createTeamApiHandler(env, { fetch: transport });
	for (const prefix of ["", "/muse-team-api", "/functions/v1/muse-team-api"]) {
		const response = await handler(
			new Request(`https://edge.example${prefix}/v1/organizations`, {
				method: "POST",
				headers: apiHeaders,
				body: '{\n  "ignored": "é"\n}',
			})
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.deepEqual(await response.json(), {
			analysisVersion: "controlled-v1",
			items: [{ id: org, name: "Actual controlled org" }],
		});
	}
	mismatch = true;
	assert.equal(
		(
			await handler(
				new Request("https://edge.example/muse-team-api/v1/organizations", {
					method: "POST",
					headers: apiHeaders,
					body: "{}",
				})
			)
		).status,
		403
	);
	assert.equal(authReads, 4);
	assert.equal(githubReads, 4);
});

test("API unknown paths, method and missing auth never reach services; health is config-only", async () => {
	const handler = createTeamApiHandler({}, { fetch: neverFetch });
	for (const path of [
		"/muse-team-api-other/v1/organizations",
		"/other/muse-team-api/v1/organizations",
		"/functions/v1/other/v1/organizations",
		"/muse-team-api/v1/organizations/",
		"/muse-team-api/v1/unknown",
		"/muse-team-api/%76%31/organizations",
	]) {
		assert.equal((await handler(new Request(`https://edge.example${path}`))).status, 404);
	}
	const url = "https://edge.example/muse-team-api/v1/organizations";
	assert.equal((await handler(new Request(url))).status, 405);
	assert.equal((await handler(new Request(url, { method: "POST", body: "{}" }))).status, 401);
	assert.equal(
		(await handler(new Request(url, { method: "POST", headers: apiHeaders, body: "{}" }))).status,
		503
	);
	const health = await handler(new Request("https://edge.example/muse-team-api/health"));
	assert.equal(health.status, 503);
	assert.ok((await health.json()).missing.includes("GITHUB_APP_ID"));
});

test("config aliases are deliberate; invalid credentials return only fixed setting names", async () => {
	const aliases = {
		...env,
		SUPABASE_ANON_KEY: undefined,
		SUPABASE_PUBLISHABLE_KEYS: '{"default":"dictionary-public"}',
	};
	assert.equal(edgeConfiguration(aliases, "api").config.publicKey, "dictionary-public");
	assert.equal(edgeConfiguration(aliases, "api").ready, true);
	const handler = createTeamApiHandler({
		...env,
		GITHUB_APP_ID: "unsafe-not-an-app-id",
		GITHUB_APP_PRIVATE_KEY: "secret-invalid-private-key-value",
		SUPABASE_URL: "https://secret-user:secret-password@db.example/wrong-path",
	});
	const health = await handler(new Request("https://edge.example/health"));
	assert.equal(health.status, 503);
	const text = await health.text();
	assert.ok(text.includes("GITHUB_APP_ID"));
	assert.ok(text.includes("GITHUB_APP_PRIVATE_KEY"));
	for (const secret of ["secret-invalid-private-key-value", "secret-password", env.MODEL_API_KEY])
		assert.ok(!text.includes(secret));
	assert.equal(
		edgeConfiguration({ ...env, SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_not_admin" }, "api")
			.ready,
		false
	);
	assert.equal(
		edgeConfiguration({ ...env, TEAM_WORKER_INVOKE_SECRET: env.SUPABASE_ANON_KEY }, "worker").ready,
		false
	);
	const alternatePublic = "public-legacy-key-that-must-never-trigger-workers";
	assert.equal(
		edgeConfiguration(
			{
				...env,
				SUPABASE_ANON_KEY: alternatePublic,
				SUPABASE_PUBLISHABLE_KEY: "preferred-public-key",
				TEAM_WORKER_INVOKE_SECRET: alternatePublic,
			},
			"worker"
		).ready,
		false
	);
});

test("webhook verifies original Unicode/whitespace HMAC and only then enqueues scoped delivery", async () => {
	const raw =
		'{\n "action":"opened", "number":1,"repository":{"id":42},"installation":{"id":7},"title":"é 🎵"\n}';
	let ingested = 0;
	let reads = 0;
	const handler = createTeamWebhookHandler(env, {
		fetch: (async (url: unknown, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			if (path === "/rest/v1/team_repositories") {
				reads++;
				return Response.json([repository]);
			}
			assert.equal(path, "/rest/v1/rpc/team_ingest_webhook");
			const body = JSON.parse(String(init?.body));
			assert.equal(body.p_digest, sha256(raw));
			assert.equal(body.p_org, org);
			assert.equal(body.p_repository, "42");
			assert.deepEqual(body.p_payload, {
				action: "opened",
				number: 1,
				repository: { id: 42 },
				installation: { id: 7 },
			});
			ingested++;
			return Response.json(null);
		}) as typeof fetch,
	});
	assert.equal((await handler(signedRequest(raw, JSON.stringify(JSON.parse(raw))))).status, 401);
	assert.equal(reads, 0);
	assert.equal((await handler(signedRequest(raw))).status, 202);
	assert.equal(reads, 1);
	assert.equal(ingested, 1);
	assert.equal(
		(
			await handler(
				new Request("https://edge.example/muse-team-webhook", { method: "POST", body: raw })
			)
		).status,
		401
	);
	assert.equal(ingested, 1);
});

test("webhook rejects oversized raw bodies and missing config without a database action", async () => {
	const handler = createTeamWebhookHandler(env, { fetch: neverFetch });
	assert.equal((await handler(signedRequest(" ".repeat(1_000_001)))).status, 400);
	assert.equal((await handler(new Request("https://edge.example/muse-team-webhook"))).status, 405);
	assert.equal((await createTeamWebhookHandler({})(signedRequest("{}"))).status, 503);
});

test("worker requires its dedicated credential and a small exact known queue body", async () => {
	let creations = 0;
	const handler = createTeamWorkerHandler(env, {
		fetch: neverFetch,
		createConsumer: () => {
			creations++;
			return { tick: async () => true };
		},
	});
	const deniedHeaders: HeadersInit[] = [
		{},
		{ Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
		{ Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
		{ Authorization: "Bearer ordinary-user-jwt" },
		{ Authorization: `Bearer ${env.TEAM_WORKER_INVOKE_SECRET}x` },
	];
	for (const headers of deniedHeaders)
		assert.equal((await handler(workerRequest({ queue: "webhook" }, headers))).status, 401);
	assert.equal((await handler(workerRequest({}, workerHeaders))).status, 400);
	for (const body of [{ queue: "other" }, { queue: "webhook", orgId: org }, ["webhook"], null])
		assert.equal((await handler(workerRequest(body))).status, 400);
	assert.equal(
		(await handler(workerRequest({ queue: "webhook", padding: "x".repeat(1024) }))).status,
		400
	);
	assert.equal(
		(await handler(workerRequest({}, { Authorization: workerHeaders.Authorization }))).status,
		415
	);
	assert.equal(creations, 0);
	assert.equal((await createTeamWorkerHandler({})(workerRequest())).status, 503);
});

test("one worker invocation calls exactly one finite tick; true means attempted, not completed", async () => {
	let calls = 0;
	const handler = createTeamWorkerHandler(env, {
		fetch: neverFetch,
		createConsumer: (options) => {
			assert.ok(options.maxRunMs > 0 && options.maxRunMs <= EDGE_MAX_RUN_MS);
			return {
				tick: async (queue, signal) => {
					calls++;
					assert.equal(queue, "preparation");
					assert.ok(signal);
					assert.equal(signal.aborted, false);
					return true;
				},
			};
		},
	});
	const response = await handler(workerRequest({ queue: "preparation" }));
	assert.deepEqual(await response.json(), { status: "attempted", queue: "preparation" });
	assert.equal(calls, 1);
	const idle = createTeamWorkerHandler(env, {
		fetch: (async (url: unknown) => {
			assert.equal(new URL(String(url)).pathname, "/rest/v1/rpc/team_claim");
			return Response.json(null);
		}) as typeof fetch,
	});
	assert.deepEqual(await (await idle(workerRequest())).json(), {
		status: "idle",
		queue: "webhook",
	});
});

test("worker total deadline bounds an uncooperative tick and stalled body, and cannot be extended", async () => {
	let tickSignal: AbortSignal | undefined;
	const handler = createTeamWorkerHandler(env, {
		maxRunMs: 30,
		fetch: neverFetch,
		createConsumer: () => ({
			tick: async (_queue, signal) => {
				tickSignal = signal;
				return new Promise<boolean>(() => {});
			},
		}),
	});
	const began = performance.now();
	assert.equal((await handler(workerRequest())).status, 504);
	assert.ok(performance.now() - began < 1000);
	assert.equal(tickSignal?.aborted, true);
	let cancelled = false;
	const stalledInit: RequestInit & { duplex: "half" } = {
		method: "POST",
		headers: workerHeaders,
		body: new ReadableStream({
			cancel: () => {
				cancelled = true;
			},
		}),
		duplex: "half",
	};
	const stalledBody = new Request("https://edge.example/muse-team-worker", stalledInit);
	assert.equal((await handler(stalledBody)).status, 504);
	assert.equal(cancelled, true);
	assert.equal(
		(await createTeamWorkerHandler(env, { maxRunMs: 110_001 })(workerRequest())).status,
		503
	);
});

test("request cancellation and shutdown abort pending worker I/O without a later success", async () => {
	for (const mode of ["request", "shutdown"] as const) {
		const controller = new AbortController();
		let observed: AbortSignal | undefined;
		const handler = createTeamWorkerHandler(env, {
			...(mode === "shutdown" ? { signal: controller.signal } : {}),
			fetch: (async (_url: unknown, init?: RequestInit) => {
				observed = init?.signal ?? undefined;
				return new Promise<Response>(() => {});
			}) as typeof fetch,
		});
		const request = workerRequest();
		const pending = handler(
			mode === "request" ? new Request(request, { signal: controller.signal }) : request
		);
		await pause(5);
		controller.abort();
		assert.equal((await pending).status, 503);
		assert.equal(observed?.aborted, true);
	}
});

test("202 waitUntil retains a real deadline, decouples caller disconnect and aborts at shutdown", async () => {
	for (const end of ["deadline", "shutdown"] as const) {
		const shutdown = new AbortController();
		const caller = new AbortController();
		let signal: AbortSignal | undefined;
		let tracked: Promise<unknown> | undefined;
		let outcome = 0;
		const ports: WorkerPorts = {
			maxRunMs: 60,
			signal: shutdown.signal,
			fetch: neverFetch,
			waitUntil: (pending) => {
				tracked = pending;
			},
			recordOutcome: (status) => {
				outcome = status;
			},
			createConsumer: () => ({
				tick: async (_queue, received) => {
					signal = received;
					return new Promise<boolean>(() => {});
				},
			}),
		};
		const response = await createTeamWorkerHandler(
			env,
			ports
		)(new Request(workerRequest(), { signal: caller.signal }));
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), { status: "accepted", queue: "webhook" });
		assert.ok(tracked);
		caller.abort();
		assert.equal(signal?.aborted, false);
		if (end === "shutdown") shutdown.abort();
		await tracked;
		assert.equal(signal?.aborted, true);
		assert.equal(outcome, end === "deadline" ? 504 : 503);
	}
});

test("failed background registration cannot start a tick; admission consumes the same total budget", async () => {
	let calls = 0;
	const rejected = createTeamWorkerHandler(env, {
		waitUntil: () => {
			throw new Error("runtime-registration-failed");
		},
		createConsumer: () => ({
			tick: async () => {
				calls++;
				return false;
			},
		}),
	});
	assert.equal((await rejected(workerRequest())).status, 503);
	await pause(1);
	assert.equal(calls, 0);
	let budget = 0;
	let tracked: Promise<unknown> | undefined;
	const handler = createTeamWorkerHandler(env, {
		maxRunMs: 150,
		waitUntil: (pending) => {
			tracked = pending;
		},
		createConsumer: (options) => {
			budget = options.maxRunMs;
			return { tick: async () => false };
		},
	});
	const delayed: RequestInit & { duplex: "half" } = {
		method: "POST",
		headers: workerHeaders,
		body: new ReadableStream({
			async start(controller) {
				await pause(60);
				controller.enqueue(new TextEncoder().encode('{"queue":"webhook"}'));
				controller.close();
			},
		}),
		duplex: "half",
	};
	assert.equal(
		(await handler(new Request("https://edge.example/muse-team-worker", delayed))).status,
		202
	);
	await tracked;
	assert.ok(budget > 0 && budget < 110, `remaining budget was ${budget}`);
});

test("scoped fetch cancels ignored late responses and body readers on abort", async () => {
	const controller = new AbortController();
	let complete: ((response: Response) => void) | undefined;
	let cancelled = 0;
	const transport = scopedFetch(
		controller.signal,
		(async () =>
			new Promise<Response>((resolve) => {
				complete = resolve;
			})) as typeof fetch
	);
	const pending = transport("https://controlled.example");
	controller.abort();
	await assert.rejects(pending);
	complete?.(
		new Response(
			new ReadableStream({
				cancel: () => {
					cancelled++;
				},
			})
		)
	);
	await pause(1);
	assert.equal(cancelled, 1);
	const second = new AbortController();
	const response = await scopedFetch(
		second.signal,
		(async () => new Response(new ReadableStream())) as typeof fetch
	)("https://controlled.example");
	const reading = response.text();
	second.abort();
	await assert.rejects(reading);
});

test("modern injected secret dictionaries configure only backend access and cannot act as worker wake keys", () => {
	const secret = "sb_secret_controlled_backend_only_1234567890";
	const dictionary = {
		...env,
		SUPABASE_SERVICE_ROLE_KEY: undefined,
		SUPABASE_SECRET_KEYS: JSON.stringify({ default: secret }),
	};
	const configured = edgeConfiguration(dictionary, "api");
	assert.equal(configured.ready, true);
	assert.equal(configured.config.adminKey, secret);
	assert.equal(
		edgeConfiguration({ ...dictionary, TEAM_WORKER_INVOKE_SECRET: secret }, "worker").ready,
		false
	);
	assert.equal(edgeConfiguration({ ...env, SUPABASE_SERVICE_ROLE_KEY: secret }, "api").ready, true);
});
