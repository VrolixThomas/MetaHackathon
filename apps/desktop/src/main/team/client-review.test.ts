import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { digest } from "../../../../../services/team/protocol";
import type { LocalReviewSubmission, TeamArtifact } from "../../shared/contracts/team";
import { TeamClient } from "./client";

const userId = "00000000-0000-4000-8000-000000000001";
const key = {
	orgId: "10000000-0000-4000-8000-000000000001",
	repositoryId: "42",
	prNumber: 1,
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	contextDigest: "c".repeat(64),
	analysisVersion: "test-v1",
};
const review = {
	id: "controlled-local",
	version: 1 as const,
	pr: {
		id: "test/repo#1",
		repository: "test/repo",
		number: 1,
		title: "Controlled PR",
		author: "test",
		url: "https://github.com/test/repo/pull/1",
		baseSha: key.baseSha,
		headSha: key.headSha,
	},
	createdAt: "2026-11-01T00:00:00Z",
	summary: "Local inference",
	orderRationale: "Read source",
	files: [],
	coverage: "complete" as const,
	evidence: "inferred-from-github" as const,
};
const submission: LocalReviewSubmission = {
	requestId: randomUUID(),
	key,
	review,
	digest: digest({ key, review }),
};
const shared: TeamArtifact = {
	key,
	review,
	digest: submission.digest,
	provenance: "reported-local-analysis",
	preparedBy: userId,
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function client(
	fetcher: typeof fetch,
	extra: Partial<ConstructorParameters<typeof TeamClient>[0]> = {}
) {
	return new TeamClient({
		url: "https://team.example/functions/api",
		auth: {
			session: async () => ({
				user: { id: userId },
				access_token: "controlled-supabase",
				refresh_token: "controlled-refresh",
				expires_at: 2000000000,
			}),
		},
		getGitHubToken: async () => "controlled-github",
		cache: { read: async () => null, write: async () => {} },
		fetch: fetcher,
		...extra,
	});
}

test("publish uses trusted API prefix and exact submission, accepts different first canonical inference with server attribution", async () => {
	const canonicalReview = { ...review, id: "other-analysis", summary: "First canonical inference" };
	const canonical = {
		...shared,
		review: canonicalReview,
		digest: digest({ key, review: canonicalReview }),
	};
	let calls = 0;
	const c = client(async (url, init) => {
		calls++;
		assert.equal(url, "https://team.example/functions/api/v1/reviews/publish");
		assert.equal(init?.method, "POST");
		assert.equal(init?.redirect, "error");
		assert.ok(init?.signal);
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer controlled-supabase");
		assert.equal(new Headers(init?.headers).get("X-GitHub-Token"), "controlled-github");
		assert.deepEqual(JSON.parse(String(init?.body)), submission);
		return Response.json(canonical);
	});
	assert.deepEqual(await c.publishReview(submission), canonical);
	assert.equal(calls, 1);
});

test("publication validates submissions before transport and rejects a canonical response for another key or digest", async () => {
	let calls = 0;
	let response = shared;
	const c = client(async () => {
		calls++;
		return Response.json(response);
	});
	await assert.rejects(c.publishReview({ ...submission, digest: "d".repeat(64) }));
	await assert.rejects(
		c.publishReview({
			...submission,
			provenance: "reported-local-analysis",
		} as LocalReviewSubmission)
	);
	assert.equal(calls, 0);
	response = { ...shared, digest: "d".repeat(64) };
	await assert.rejects(c.publishReview(submission));
	const otherKey = { ...key, contextDigest: "e".repeat(64) };
	response = { ...shared, key: otherKey, digest: digest({ key: otherKey, review }) };
	await assert.rejects(c.publishReview(submission), /invalid/);
});

for (const operation of ["load", "publish"] as const) {
	for (const stage of ["credential", "fetch", "body"] as const) {
		test(`${operation} cancels during ${stage} even if the adapter ignores abort and suppresses late cache writes`, async () => {
			const ready = deferred<void>();
			const late = deferred<Response>();
			const credential = deferred<string | undefined>();
			let writes = 0;
			let requests = 0;
			const c = client(
				async () => {
					requests++;
					ready.resolve();
					if (stage === "fetch") return late.promise;
					return new Response(
						new ReadableStream({
							pull: () => new Promise(() => {}),
							cancel: () => new Promise(() => {}),
						})
					);
				},
				{
					getGitHubToken:
						stage === "credential"
							? () => {
									ready.resolve();
									return credential.promise;
								}
							: async () => "controlled-github",
					cache: {
						read: async () => null,
						write: async () => {
							writes++;
						},
					},
				}
			);
			const controller = new AbortController();
			const pending =
				operation === "load"
					? c.load(key, controller.signal)
					: c.publishReview(submission, controller.signal);
			await ready.promise;
			controller.abort();
			await assert.rejects(pending, { name: "AbortError" });
			late.resolve(Response.json(shared));
			credential.resolve("controlled-github");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(writes, 0);
			assert.equal(requests, stage === "credential" ? 0 : 1);
		});
	}
}

test("cancelled artifact cache read cannot later persist a result", async () => {
	const entered = deferred<void>();
	const gate = deferred<null>();
	let writes = 0;
	const c = client(async () => Response.json(shared), {
		cache: {
			read: () => {
				entered.resolve();
				return gate.promise;
			},
			write: async () => {
				writes++;
			},
		},
	});
	const controller = new AbortController();
	const pending = c.load(key, controller.signal);
	await entered.promise;
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
	gate.resolve(null);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(writes, 0);
});

for (const operation of ["load", "publish"] as const) {
	test(`${operation} checks account generation after the final credential await`, async () => {
		let revision = 0;
		let tokenCalls = 0;
		let writes = 0;
		const c = client(async () => Response.json(shared), {
			getAccountRevision: () => revision,
			getGitHubToken: async () => {
				if (++tokenCalls === 2) revision++;
				return "controlled-github";
			},
			cache: {
				read: async () => null,
				write: async () => {
					writes++;
				},
			},
		});
		await assert.rejects(
			operation === "load" ? c.load(key) : c.publishReview(submission),
			/unauthorized/
		);
		assert.equal(writes, 0);
	});
}
