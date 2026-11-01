import assert from "node:assert/strict";
import { test } from "node:test";
import { HostedGitHub } from "./github";
import { TeamError, digest } from "./protocol";
import { UserGitHub } from "./user-github";

const repository = {
	org_id: "10000000-0000-4000-8000-000000000001",
	repository_id: "42",
	full_name: "test/repo",
	installation_id: null,
	enabled: true,
};
function fixture(mutate?: (pr: Record<string, unknown>, read: number) => unknown) {
	let reads = 0;
	const calls: { path: string; token: string | null }[] = [];
	const transport = (async (raw: unknown, init?: RequestInit) => {
		const path = new URL(String(raw)).pathname;
		assert.equal(new URL(String(raw)).origin, "https://api.github.com");
		assert.equal(init?.method ?? "GET", "GET");
		assert.equal(init?.redirect, "error");
		calls.push({ path, token: new Headers(init?.headers).get("authorization") });
		if (path === "/repositories/42") return Response.json({ id: 42, full_name: "test/repo" });
		if (path === "/repos/test/repo/pulls/1/files")
			return Response.json([
				{
					filename: "a.ts",
					status: "modified",
					additions: 1,
					deletions: 1,
					patch: "@@ -1 +1 @@\n-old\n+new",
				},
			]);
		assert.equal(path, "/repos/test/repo/pulls/1");
		const pr = {
			number: 1,
			title: "Exact title",
			html_url: "https://github.com/test/repo/pull/1",
			body: "Exact source description",
			user: { id: 101, login: "author" },
			base: { sha: "a".repeat(40), repo: { id: 42 } },
			head: { sha: "b".repeat(40) },
			changed_files: 1,
		};
		return Response.json(mutate?.(pr, ++reads) ?? pr);
	}) as typeof fetch;
	return { transport, calls };
}
test("user source uses only the request token for canonical pinned context, including local-only repos", async () => {
	const { transport, calls } = fixture();
	const source = new UserGitHub(transport);
	const first = await source.context(repository, 1, undefined, "user-a");
	const second = await source.context(repository, 1, undefined, "user-b");
	assert.deepEqual(first, second);
	assert.equal(first.contextDigest, digest(first.context));
	assert.equal(first.context.description, "Exact source description");
	assert.equal(first.context.files[0]?.path, "a.ts");
	assert.equal(first.context.pr.id, "test/repo#1");
	assert.ok(calls.slice(0, 5).every((call) => call.token === "Bearer user-a"));
	assert.ok(calls.slice(5).every((call) => call.token === "Bearer user-b"));
	assert.equal(calls.length, 10);
});
test("user source never falls back to App or CLI credentials; archived App rejects a null installation before JWT or fetch", async () => {
	let calls = 0;
	const transport = (async () => {
		calls++;
		throw new Error("unexpected read");
	}) as typeof fetch;
	const source = new UserGitHub(transport);
	await assert.rejects(
		source.context(repository, 1),
		(error) => error instanceof TeamError && error.code === "unauthorized"
	);
	await assert.rejects(source.context({ ...repository, enabled: false }, 1, undefined, "user"));
	const archived = new HostedGitHub({ appId: "", privateKey: "", fetch: transport });
	await assert.rejects(
		archived.authorize(repository),
		(error) => error instanceof TeamError && error.code === "forbidden"
	);
	await assert.rejects(archived.context(repository, 1));
	assert.equal(calls, 0);
});
test("user source rejects changed final title/body/author/URL/repository and pinned SHAs", async () => {
	const changes = [
		{ title: "Changed title" },
		{ body: "Changed description" },
		{ user: { login: "other" } },
		{ html_url: "https://github.com/other/repo/pull/1" },
		{ number: 2 },
		{ base: { sha: "a".repeat(40), repo: { id: 43 } } },
		{ head: { sha: "f".repeat(40) } },
		{ base: { sha: "f".repeat(40), repo: { id: 42 } } },
	];
	for (const change of changes) {
		const { transport } = fixture((pr, read) => (read === 3 ? { ...pr, ...change } : pr));
		await assert.rejects(
			new UserGitHub(transport).context(repository, 1, undefined, "user"),
			(error) => error instanceof TeamError && error.code === "conflict"
		);
	}
});
test("user source cancellation fences an ignored fetch and a stalled body", async () => {
	for (const body of [false, true]) {
		const controller = new AbortController();
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		let calls = 0;
		let observed: AbortSignal | null | undefined;
		const transport = (async (_raw: unknown, init?: RequestInit) => {
			calls++;
			observed = init?.signal;
			started();
			return body ? new Response(new ReadableStream()) : new Promise<Response>(() => {});
		}) as typeof fetch;
		const pending = new UserGitHub(transport).context(repository, 1, controller.signal, "user");
		await ready;
		controller.abort();
		await assert.rejects(pending);
		assert.equal(observed?.aborted, true);
		assert.equal(calls, 1);
	}
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	const transport = (async () => {
		calls++;
		throw new Error("unexpected dispatch");
	}) as typeof fetch;
	await assert.rejects(new UserGitHub(transport).context(repository, 1, controller.signal, "user"));
	assert.equal(calls, 0);
});
