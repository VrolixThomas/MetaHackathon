import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { HostedGitHub } from "./github";
import { digest } from "./protocol";

const repository = {
	org_id: "10000000-0000-4000-8000-000000000001",
	repository_id: "42",
	full_name: "test/repo",
	installation_id: "7",
	enabled: true,
};
test("hosted GitHub App JWT scopes token to actual allowed repository and reads bounded pinned context", async () => {
	const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
	let tokenRequests = 0;
	let changed = false;
	const transport = (async (url: unknown, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		if (path === "/app/installations/7") {
			const jwt = (new Headers(init?.headers).get("authorization") ?? "").slice(7).split(".");
			assert.equal(jwt.length, 3);
			assert.ok(
				verify(
					"RSA-SHA256",
					Buffer.from(`${jwt[0]}.${jwt[1]}`),
					keys.publicKey,
					Buffer.from(jwt[2] ?? "", "base64url")
				)
			);
			return Response.json({ id: 7, suspended_at: null });
		}
		if (path.endsWith("/access_tokens")) {
			tokenRequests++;
			const body = JSON.parse(String(init?.body));
			assert.deepEqual(body.repository_ids, [42]);
			assert.deepEqual(body.permissions, {
				contents: "read",
				pull_requests: "read",
				metadata: "read",
			});
			return Response.json({ token: "controlled-installation-token" });
		}
		if (path === "/repositories/42")
			return Response.json({ id: changed ? 43 : 42, full_name: "test/repo" });
		if (path.endsWith("/files"))
			return Response.json([
				{
					filename: "a.ts",
					status: "modified",
					additions: 1,
					deletions: 1,
					patch: "@@ -1 +1 @@\n-old\n+new",
				},
			]);
		if (path === "/repos/test/repo/pulls/1")
			return Response.json({
				number: 1,
				html_url: "https://github.com/test/repo/pull/1",
				title: "Exact title",
				user: { login: "author" },
				base: { sha: "a".repeat(40) },
				head: { sha: "b".repeat(40) },
				body: "Exact description",
				changed_files: 1,
			});
		throw new Error("Unexpected controlled route");
	}) as typeof fetch;
	const github = new HostedGitHub({
		appId: "123",
		privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		fetch: transport,
	});
	const result = await github.context(repository, 1, new AbortController().signal);
	assert.equal(result.contextDigest, digest(result.context));
	assert.equal(result.context.description, "Exact description");
	assert.equal(tokenRequests, 1);
	changed = true;
	await assert.rejects(github.context(repository, 1, new AbortController().signal));
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("GitHub ignored cancellation")), 500);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
const testKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
	.privateKey.export({ type: "pkcs8", format: "pem" })
	.toString();
function controlledGitHub(
	intercept?: (stage: string, signal: AbortSignal) => Promise<Response> | undefined
) {
	const calls: string[] = [];
	let metadata = 0;
	const github = new HostedGitHub({
		appId: "123",
		privateKey: testKey,
		fetch: (async (url, init) => {
			const path = new URL(String(url)).pathname;
			const stage = path.endsWith("/installation")
				? "installation"
				: path === "/app/installations/7"
					? "authorization"
					: path.endsWith("/access_tokens")
						? "token"
						: path === "/repositories/42"
							? "repository"
							: path.endsWith("/files")
								? "files"
								: `metadata-${++metadata}`;
			calls.push(stage);
			const signal = init?.signal;
			assert.ok(signal);
			const override = intercept?.(stage, signal);
			if (override) return override;
			if (["installation", "authorization"].includes(stage))
				return Response.json({ id: 7, suspended_at: null });
			if (stage === "token") return Response.json({ token: "controlled-token" });
			if (stage === "repository") return Response.json({ id: 42, full_name: "test/repo" });
			if (stage === "files")
				return Response.json([
					{
						filename: "a.ts",
						status: "modified",
						additions: 1,
						deletions: 1,
						patch: "@@ -1 +1 @@\n-old\n+new",
					},
				]);
			return Response.json({
				number: 1,
				html_url: "https://github.com/test/repo/pull/1",
				title: "Exact title",
				user: { login: "author" },
				base: { sha: "a".repeat(40) },
				head: { sha: "b".repeat(40) },
				body: "Description",
				changed_files: 1,
			});
		}) as typeof fetch,
	});
	return { github, calls };
}

test("hosted GitHub optional signals abort installation, authorization and context before dispatch", async () => {
	const { github, calls } = controlledGitHub();
	await assert.rejects(github.installation("test/repo", "7", AbortSignal.abort()));
	await assert.rejects(github.authorize(repository, AbortSignal.abort()));
	await assert.rejects(github.context(repository, 1, AbortSignal.abort()));
	assert.deepEqual(calls, []);
	assert.equal(await github.installation("test/repo", "7"), "7");
	assert.equal((await github.context(repository, 1)).context.pr.headSha, "b".repeat(40));
});

for (const stage of [
	"installation",
	"authorization",
	"token",
	"repository",
	"metadata-1",
	"files",
	"metadata-2",
	"metadata-3",
]) {
	test(`hosted GitHub abort during ${stage} fetch discards late result and starts no next request`, async () => {
		const entered = deferred<void>();
		const pending = deferred<Response>();
		let transportSignal: AbortSignal | undefined;
		const { github, calls } = controlledGitHub((current, signal) => {
			if (current === stage) {
				transportSignal = signal;
				entered.resolve();
				return pending.promise;
			}
		});
		const controller = new AbortController();
		const operation: Promise<unknown> =
			stage === "installation"
				? github.installation("test/repo", "7", controller.signal)
				: github.context(repository, 1, controller.signal);
		await bounded(entered.promise);
		controller.abort();
		await assert.rejects(bounded(operation));
		assert.ok(transportSignal?.aborted);
		const count = calls.length;
		pending.resolve(Response.json({ id: 7, suspended_at: null, token: "late" }));
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(calls.length, count);
	});
}

test("hosted GitHub final metadata body and noncooperative cancel cannot retain caller", async () => {
	const entered = deferred<void>();
	const cancel = deferred<void>();
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>(
		{
			pull() {
				entered.resolve();
				return new Promise(() => {});
			},
			cancel() {
				cancelled = true;
				return cancel.promise;
			},
		},
		{ highWaterMark: 0 }
	);
	const { github, calls } = controlledGitHub((stage) =>
		stage === "metadata-3" ? Promise.resolve(new Response(body)) : undefined
	);
	const controller = new AbortController();
	const operation = github.context(repository, 1, controller.signal);
	await bounded(entered.promise);
	controller.abort();
	await assert.rejects(bounded(operation));
	assert.equal(cancelled, true);
	assert.equal(calls.at(-1), "metadata-3");
	cancel.resolve();
});

test(
	"hosted GitHub retains its 20s per-call timeout when no caller is supplied",
	{ timeout: 23000 },
	async () => {
		let transportSignal: AbortSignal | undefined;
		const { github } = controlledGitHub((_stage, signal) => {
			transportSignal = signal;
			return new Promise(() => {});
		});
		await assert.rejects(github.installation("test/repo"));
		assert.ok(transportSignal?.aborted);
	}
);
