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
