import assert from "node:assert/strict";
import { test } from "node:test";
import type { CredentialProvider } from "../../shared/contracts";
import type { CredentialAccess } from "./credentials";
import { GitHubClient } from "./github";
import { createRuntimeRouter } from "./router";
import { RuntimeService } from "./service";

const metadata = {
	number: 1,
	html_url: "https://github.com/owner/repo/pull/1",
	title: "Real PR shape",
	user: { login: "reviewer" },
	base: { sha: "b".repeat(40) },
	head: { sha: "a".repeat(40) },
	body: "Author description",
	changed_files: 1,
};
const file = {
	filename: "src/app.ts",
	status: "modified",
	additions: 1,
	deletions: 1,
	patch: "@@ -1 +1 @@\n-old\n+new",
};
function credentialAdapter(initial: string | undefined = "fake-test-credential"): CredentialAccess {
	const values = new Map<CredentialProvider, string>();
	if (initial) values.set("github", initial);
	return {
		async get(provider) {
			return values.get(provider);
		},
		async set(provider, secret) {
			values.set(provider, secret);
		},
		async delete(provider) {
			values.delete(provider);
		},
		async status() {
			return (["github", "meta", "elevenlabs"] as const).map((provider) => ({
				provider,
				configured: values.has(provider),
				storage: "env-file" as const,
			}));
		},
	};
}
function transport(
	handler: (url: URL, init?: RequestInit) => Response | Promise<Response>
): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		assert.equal(url.origin, "https://api.github.com");
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "error");
		return handler(url, init);
	}) as typeof fetch;
}

test("PR context is HTTP-only, preserves exact refs, description and file patch", async () => {
	const paths: string[] = [];
	const client = new GitHubClient(
		credentialAdapter(),
		transport((url) => {
			paths.push(url.pathname + url.search);
			return Response.json(url.pathname.endsWith("/files") ? [file] : metadata);
		})
	);
	const context = await client.prContext("owner/repo#1");
	assert.equal(context.pr.headSha, metadata.head.sha);
	assert.equal(context.pr.baseSha, metadata.base.sha);
	assert.equal(context.description, metadata.body);
	assert.deepEqual(context.files, [
		{ path: file.filename, status: file.status, additions: 1, deletions: 1, patch: file.patch },
	]);
	assert.equal(context.truncated, false);
	assert.deepEqual(paths, [
		"/repos/owner/repo/pulls/1",
		"/repos/owner/repo/pulls/1/files?per_page=100&page=1",
		"/repos/owner/repo/pulls/1",
	]);
});

test("PR context bounds files, individual patches, description and total supplied text", async () => {
	let reads = 0;
	const client = new GitHubClient(
		credentialAdapter(),
		transport((url) => {
			reads++;
			return Response.json(
				url.pathname.endsWith("/files")
					? Array.from({ length: 100 }, (_, i) => ({
							...file,
							filename: `src/${i}.ts`,
							patch: "x".repeat(25_000),
						}))
					: { ...metadata, body: "d".repeat(40_000), changed_files: 101 }
			);
		})
	);
	const context = await client.prContext("owner/repo#1");
	assert.equal(context.description.length, 32_000);
	assert.ok(context.files.length <= 100);
	assert.ok(context.files.every((file) => (file.patch?.length ?? 0) <= 20_000));
	assert.ok(
		context.description.length +
			context.files.reduce(
				(sum, file) => sum + file.path.length + file.status.length + (file.patch?.length ?? 0),
				0
			) <=
			120_000
	);
	assert.equal(context.truncated, true);
	assert.equal(reads, 3);
});

test("exactly 100 complete files are not falsely truncated; unavailable patches are explicit", async () => {
	for (const missing of [false, true]) {
		const batch = Array.from({ length: 100 }, (_, i) => ({
			...file,
			filename: `src/${i}.ts`,
			...(missing ? { patch: undefined } : {}),
		}));
		const client = new GitHubClient(
			credentialAdapter(),
			transport((url) =>
				Response.json(
					url.pathname.endsWith("/files") ? batch : { ...metadata, body: null, changed_files: 100 }
				)
			)
		);
		const context = await client.prContext("owner/repo#1");
		assert.equal(context.files.length, 100);
		assert.equal(context.description, "");
		assert.equal(context.truncated, missing);
	}
});

test("invalid identifiers dispatch no HTTP and demo-shaped identifiers have no fixture fallback", async () => {
	let calls = 0;
	const client = new GitHubClient(
		credentialAdapter(),
		transport(() => {
			calls++;
			return new Response("", { status: 404 });
		})
	);
	for (const id of [
		"owner/repo#0",
		"owner/repo#01",
		"../repo#1",
		"owner/..#1",
		"https://github.com/owner/repo/pull/1",
		"owner/repo#1?x=1",
		"owner%2frepo/x#1",
		"owner/repo#9007199254740993",
		"owner/repo#1\n",
	])
		await assert.rejects(client.prContext(id));
	assert.equal(calls, 0);
	await assert.rejects(client.prContext("demo/shop-web#1284"), /inaccessible/);
	assert.equal(calls, 1);
});

test("PR context rejects head/base changes and observes abort after response body reads", async () => {
	for (const revision of ["base", "head"] as const) {
		let reads = 0;
		const client = new GitHubClient(
			credentialAdapter(),
			transport((url) => {
				if (url.pathname.endsWith("/files")) return Response.json([file]);
				return Response.json(
					++reads === 1 ? metadata : { ...metadata, [revision]: { sha: "c".repeat(40) } }
				);
			})
		);
		await assert.rejects(client.prContext("owner/repo#1"), /revision changed/);
	}
	const controller = new AbortController();
	const client = new GitHubClient(
		credentialAdapter(),
		transport(() => {
			const response = Response.json(metadata);
			Object.defineProperty(response, "json", {
				value: async () => {
					controller.abort();
					return metadata;
				},
			});
			return response;
		})
	);
	await assert.rejects(client.prContext("owner/repo#1", controller.signal), /cancelled/);
});

test("open authored and review-requested searches deduplicate before hydration", async () => {
	const queries: string[] = [];
	const hydrated: string[] = [];
	const client = new GitHubClient(
		credentialAdapter(),
		transport((url) => {
			if (url.pathname === "/user")
				return Response.json({ login: "reviewer", avatar_url: "https://example.invalid/avatar" });
			if (url.pathname === "/search/issues") {
				const query = url.searchParams.get("q") ?? "";
				queries.push(query);
				return Response.json({
					items: query.includes("author:")
						? [
								{ number: 1, repository_url: "https://api.github.com/repos/OWNER/REPO" },
								{ number: 2, repository_url: "https://api.github.com/repos/owner/own" },
							]
						: [{ number: 1, repository_url: "https://api.github.com/repos/owner/repo" }],
				});
			}
			hydrated.push(url.pathname);
			return Response.json({ ...metadata, number: url.pathname.endsWith("/2") ? 2 : 1 });
		})
	);
	const prs = await client.reviewRequests();
	assert.deepEqual(
		prs.map((pr) => pr.id),
		["owner/repo#1", "owner/own#2"]
	);
	assert.deepEqual(queries, [
		"is:pr is:open review-requested:reviewer",
		"is:pr is:open author:reviewer",
	]);
	assert.equal(hydrated.length, 2);
});

test("gh import writes to the injected store and returns only account; failures redact CLI output", async () => {
	const store = credentialAdapter();
	await store.delete("github");
	const client = new GitHubClient(
		store,
		transport(async (_url, init) => {
			assert.equal(await store.get("github"), "mock-imported-secret");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mock-imported-secret");
			return Response.json({ login: "reviewer", avatar_url: "https://example.invalid/avatar" });
		}),
		undefined,
		async () => "mock-imported-secret"
	);
	const account = await client.importGhToken();
	assert.equal(account.login, "reviewer");
	assert.ok(!JSON.stringify(account).includes("secret"));
	assert.equal((await store.status())[0]?.storage, "env-file");
	const missing = new GitHubClient(
		store,
		transport(() => {
			throw Error("Must not dispatch");
		}),
		undefined,
		async () => {
			throw Error("stderr mock-imported-secret");
		}
	);
	await assert.rejects(
		missing.importGhToken(),
		(error: Error) =>
			error.message.includes("gh auth login --hostname github.com") &&
			!error.message.includes("mock-imported-secret")
	);
});

test("GitHub authentication and access errors give actionable guidance without raw bodies", async () => {
	for (const [status, pattern] of [
		[401, /session expired.*gh auth login/],
		[403, /access denied or rate-limited/],
		[404, /not found or inaccessible/],
	] as const) {
		const client = new GitHubClient(
			credentialAdapter(),
			transport(() => new Response("mock-sensitive-body", { status }))
		);
		await assert.rejects(
			client.account(),
			(error: Error) =>
				pattern.test(error.message) && !error.message.includes("mock-sensitive-body")
		);
	}
});

test("runtime and router use the injected credential port and real context port without preparing fixtures", async () => {
	const store = credentialAdapter();
	const runtime = new RuntimeService({
		userDataPath: "/unused/v1-test",
		fixturesPath: "/unused/v1-fixtures",
		credentialStore: store,
		encryption: {
			isEncryptionAvailable: () => {
				throw Error("Legacy encryption must not be accessed");
			},
			encryptString: () => {
				throw Error("unused");
			},
			decryptString: () => {
				throw Error("unused");
			},
		},
		submissionLedger: { reserve: () => undefined, complete: () => {} },
		createPreviewPage: () => {
			throw Error("No preview for V1 context");
		},
	});
	const caller = createRuntimeRouter(() => runtime).createCaller({});
	try {
		assert.equal(runtime.credentials, store);
		assert.equal((await caller.credentialStatus())[0]?.storage, "env-file");
		await caller.setCredential({ provider: "meta", secret: "mock-meta" });
		assert.equal(await store.get("meta"), "mock-meta");
		await caller.deleteCredential({ provider: "meta" });
		assert.equal(await store.get("meta"), undefined);
		const client = new GitHubClient(
			store,
			transport((url) => Response.json(url.pathname.endsWith("/files") ? [file] : metadata))
		);
		runtime.github.prContext = (prId, signal) => client.prContext(prId, signal);
		assert.equal((await caller.prContext({ prId: "owner/repo#1" })).pr.id, "owner/repo#1");
		assert.throws(() => runtime.getPrepared("owner/repo#1"), /not prepared/);
		await assert.rejects(caller.prContext({ prId: "../repo#1" }));
	} finally {
		await runtime.dispose();
	}
});
