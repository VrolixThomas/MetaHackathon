import assert from "node:assert/strict";
import { test } from "node:test";
import { HubGitHubClient } from "./hub-github";

const timestamp = "2026-10-28T12:00:00Z";
const repository = { full_name: "Owner/Repo", default_branch: "main", private: true };
function pull(number = 1, author = "viewer") {
	return {
		number,
		html_url: `https://github.com/Owner/Repo/pull/${number}`,
		title: `Change ${number}`,
		user: { login: author },
		base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "Owner/Repo" } },
		head: { sha: "a".repeat(40), ref: "change" },
		state: "open",
		draft: false,
		updated_at: timestamp,
	};
}
function search(numbers: number[], extra = {}) {
	return {
		total_count: numbers.length,
		incomplete_results: false,
		items: numbers.map((number) => ({
			number,
			repository_url: "https://api.github.com/repos/Owner/Repo",
			pull_request: { url: `https://api.github.com/repos/Owner/Repo/pulls/${number}` },
		})),
		...extra,
	};
}
function comment(id = 1, author = "reviewer", body = "Actual comment") {
	return {
		id,
		body,
		user: { login: author },
		html_url: `https://github.com/Owner/Repo/pull/1#issuecomment-${id}`,
		created_at: timestamp,
		updated_at: timestamp,
	};
}
function review(id = 1, author = "reviewer", state = "COMMENTED") {
	return {
		id,
		body: "Actual review",
		user: { login: author },
		html_url: `https://github.com/Owner/Repo/pull/1#pullrequestreview-${id}`,
		submitted_at: timestamp,
		state,
		commit_id: "a".repeat(40),
	};
}
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function client(
	handler: Handler,
	getToken = async (): Promise<string | undefined> => "test-token"
) {
	return new HubGitHubClient({
		getToken,
		fetch: (async (input, init) => {
			assert.equal(new URL(String(input)).origin, "https://api.github.com");
			assert.equal(init?.redirect, "error");
			assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
			assert.equal(new Headers(init?.headers).get("X-GitHub-Api-Version"), "2022-11-28");
			return handler(new URL(String(input)), init ?? {});
		}) as typeof fetch,
	});
}
function queueHandler(
	incoming = [1],
	own = [2],
	feedback: (url: URL) => Response = () => Response.json([])
): Handler {
	return (url) => {
		if (url.pathname === "/user") return Response.json({ login: "viewer", name: "Real Name" });
		if (url.pathname === "/repos/Owner/Repo") return Response.json(repository);
		if (url.pathname === "/search/issues")
			return Response.json(
				search(url.searchParams.get("q")?.includes("review-requested:viewer") ? incoming : own)
			);
		const number = Number(/\/pulls\/(\d+)$/.exec(url.pathname)?.[1]);
		if (number) return Response.json(pull(number, own.includes(number) ? "viewer" : "colleague"));
		return feedback(url);
	};
}

test("account and canonical repository choices come from GitHub, including private repositories", async () => {
	const github = client((url) =>
		Response.json(
			url.pathname === "/user"
				? { login: "viewer", name: null }
				: url.pathname === "/user/repos"
					? [repository]
					: repository
		)
	);
	assert.deepEqual(await github.account(), { login: "viewer", name: null });
	assert.deepEqual(await github.repository("Owner/Repo"), {
		repository: "Owner/Repo",
		defaultBranch: "main",
		private: true,
	});
	assert.deepEqual(await github.repositories(), [
		{ repository: "Owner/Repo", defaultBranch: "main", private: true },
	]);
});

test("repository pagination uses fixed-host page numbers, deduplicates names and never follows Link hosts", async () => {
	const pages: number[] = [];
	const github = client((url) => {
		pages.push(Number(url.searchParams.get("page")));
		return pages.length === 1
			? Response.json([repository], {
					headers: { Link: '<https://attacker.invalid/?token=bad>; rel="next"' },
				})
			: Response.json([repository, { ...repository, full_name: "Owner/Other" }]);
	});
	assert.equal((await github.repositories()).length, 2);
	assert.deepEqual(pages, [1, 2]);
});

test("repository listing rejects a bounded partial result instead of returning a truncated list", async () => {
	let calls = 0;
	await assert.rejects(
		client(() => {
			calls++;
			return Response.json([repository], {
				headers: { Link: '<https://api.github.com/user/repos?page=6>; rel="next"' },
			});
		}).repositories(),
		/500-item/
	);
	assert.equal(calls, 5);
});

test("reviews are only requested incoming (including teams per API) and separate viewer-owned PRs", async () => {
	const queries: string[] = [];
	const handler = queueHandler([1, 3], [2]);
	const github = client((url, init) => {
		if (url.pathname === "/search/issues") queries.push(url.searchParams.get("q") ?? "");
		return handler(url, init);
	});
	const rows = await github.reviews("Owner/Repo");
	assert.deepEqual(queries, [
		"repo:Owner/Repo is:pr is:open review-requested:viewer",
		"repo:Owner/Repo is:pr is:open author:viewer",
	]);
	assert.deepEqual(
		rows.map((row) => [row.pr.number, row.kind, row.reviewState]),
		[
			[1, "incoming", "requested"],
			[3, "incoming", "requested"],
			[2, "own", "waiting"],
		]
	);
	assert.ok(rows.every((row) => row.repositoryId === "owner/repo"));
	assert.ok(!rows.some((row) => row.pr.number === 4));
});

test("own PR feedback counts exclude author messages, preserve state and count actual remote feedback", async () => {
	const rows = await client(
		queueHandler([], [2], (url) =>
			Response.json(
				url.pathname.endsWith("/reviews")
					? [review(1, "reviewer", "CHANGES_REQUESTED"), review(2, "viewer")]
					: url.pathname.includes("/issues/")
						? [comment(3, "viewer"), comment(4)]
						: []
			)
		)
	).reviews("Owner/Repo");
	assert.equal(rows[0]?.feedbackCount, 2);
	assert.equal(rows[0]?.reviewState, "changes-requested");
	assert.equal(rows[0]?.lastFeedbackAt, timestamp);
});

test("latest review per reviewer supersedes an earlier requested change", async () => {
	const later = { ...review(2, "reviewer", "APPROVED"), submitted_at: "2026-10-28T13:00:00Z" };
	const rows = await client(
		queueHandler([], [2], (url) =>
			Response.json(
				url.pathname.endsWith("/reviews") ? [review(1, "reviewer", "CHANGES_REQUESTED"), later] : []
			)
		)
	).reviews("Owner/Repo");
	assert.equal(rows[0]?.reviewState, "approved");
});

test("a later conversation-only review does not withdraw an earlier formal approval", async () => {
	const comment = { ...review(2), submitted_at: "2026-10-28T13:00:00Z" };
	const rows = await client(
		queueHandler([], [2], (url) =>
			Response.json(
				url.pathname.endsWith("/reviews") ? [review(1, "reviewer", "APPROVED"), comment] : []
			)
		)
	).reviews("Owner/Repo");
	assert.equal(rows[0]?.reviewState, "approved");
});

test("feedback includes actual review, inline suggestion, conversation and original pinned location", async () => {
	const body = "Use this instead:\n```suggestion\nreturn exact(value);\n```\n";
	const github = client((url) =>
		Response.json(
			url.pathname.endsWith("/reviews")
				? [review()]
				: url.pathname.includes("/issues/")
					? [comment(3)]
					: [
							{
								...comment(2, "reviewer", body),
								path: "src/value.ts",
								side: "RIGHT",
								line: null,
								original_line: 17,
								commit_id: "a".repeat(40),
								original_commit_id: "c".repeat(40),
							},
						]
		)
	);
	const rows = await github.feedback("Owner/Repo#1");
	assert.deepEqual(
		rows.map((row) => row.kind),
		["review", "inline", "conversation"]
	);
	assert.equal(rows[1]?.body, body);
	assert.equal(rows[1]?.suggestion, "return exact(value);");
	assert.equal(rows[1]?.path, "src/value.ts");
	assert.equal(rows[1]?.line, 17);
	assert.equal(rows[1]?.commitSha, "c".repeat(40));
	assert.equal(rows[2]?.commitSha, null);
	assert.equal(rows[0]?.commitSha, "a".repeat(40));
});

test("a failed feedback page rejects the queue and never invents zero counts", async () => {
	await assert.rejects(
		client(
			queueHandler([], [2], () => new Response("provider private error", { status: 503 }))
		).reviews("Owner/Repo"),
		/HTTP 503/
	);
});

test("ambiguous suggestion ranges and LEFT-side diff anchors retain the exact body without implying a single-line edit", async () => {
	const plain = "```suggestion\nnext(value);\n```";
	const variants = [
		{
			body: plain,
			side: "RIGHT",
			start_line: null,
			line: 9,
			suggestion: "next(value);",
			expectedLine: 9,
		},
		{ body: plain, side: "LEFT", start_line: null, line: 9, suggestion: null, expectedLine: null },
		{ body: plain, side: "RIGHT", start_line: 7, line: 9, suggestion: null, expectedLine: 9 },
		{
			body: "```suggestion:-1+1\nnext(value);\n```",
			side: "RIGHT",
			start_line: null,
			line: 9,
			suggestion: null,
			expectedLine: 9,
		},
		{
			body: `${plain}\n\n${plain}`,
			side: "RIGHT",
			start_line: null,
			line: 9,
			suggestion: null,
			expectedLine: 9,
		},
	];
	for (const variant of variants) {
		const rows = await client((url) =>
			Response.json(
				url.pathname.endsWith("/comments") && url.pathname.includes("/pulls/")
					? [
							{
								...comment(1, "reviewer", variant.body),
								path: "src/value.ts",
								side: variant.side,
								line: variant.line,
								start_line: variant.start_line,
								original_line: variant.line,
								commit_id: "a".repeat(40),
								original_commit_id: "a".repeat(40),
							},
						]
					: []
			)
		).feedback("Owner/Repo#1");
		assert.equal(rows[0]?.body, variant.body);
		assert.equal(rows[0]?.suggestion, variant.suggestion);
		assert.equal(rows[0]?.line, variant.expectedLine);
	}
});

test("search rejects incomplete, over-limit, changed totals, missing pages and foreign resource identities", async () => {
	for (const payload of [
		search([], { incomplete_results: true }),
		search([], { total_count: 501 }),
		search([], { total_count: 1 }),
		{
			...search([1]),
			items: [
				{ ...search([1]).items[0], repository_url: "https://attacker.invalid/repos/Owner/Repo" },
			],
		},
	]) {
		const handler = queueHandler();
		await assert.rejects(
			client((url, init) =>
				url.pathname === "/search/issues" ? Response.json(payload) : handler(url, init)
			).reviews("Owner/Repo")
		);
	}
	let searches = 0;
	const handler = queueHandler();
	await assert.rejects(
		client((url, init) =>
			url.pathname === "/search/issues"
				? Response.json(
						++searches === 1
							? search(
									Array.from({ length: 100 }, (_, i) => i + 1),
									{ total_count: 101 }
								)
							: search([101], { total_count: 102 })
					)
				: handler(url, init)
		).reviews("Owner/Repo"),
		/changed during pagination/
	);
});

test("requested review search paginates beyond 100 while preserving each PR's pinned SHAs", async () => {
	const handler = queueHandler(
		Array.from({ length: 101 }, (_, i) => i + 1),
		[]
	);
	let searches = 0;
	const github = client((url, init) => {
		if (
			url.pathname === "/search/issues" &&
			url.searchParams.get("q")?.includes("review-requested:")
		) {
			searches++;
			return Response.json(
				search(
					Number(url.searchParams.get("page")) === 1
						? Array.from({ length: 100 }, (_, i) => i + 1)
						: [101],
					{ total_count: 101 }
				)
			);
		}
		return handler(url, init);
	});
	const rows = await github.reviews("Owner/Repo");
	assert.equal(searches, 2);
	assert.equal(rows.length, 101);
	assert.ok(
		rows.every((row) => row.pr.baseSha === "b".repeat(40) && row.pr.headSha === "a".repeat(40))
	);
});

test("createDraft sends exactly the authorized draft fields and returns an actual provider PR", async () => {
	let calls = 0;
	const github = client((url, init) => {
		calls++;
		assert.equal(url.pathname, "/repos/Owner/Repo/pulls");
		assert.equal(init.method, "POST");
		assert.deepEqual(JSON.parse(String(init.body)), {
			base: "main",
			head: "change",
			title: "Work result",
			body: "Real body",
			draft: true,
		});
		return Response.json({ ...pull(99), draft: true });
	});
	const result = await github.createDraft({
		repository: "Owner/Repo",
		base: "main",
		head: "change",
		title: "Work result",
		body: "Real body",
	});
	assert.equal(calls, 1);
	assert.equal(result.id, "Owner/Repo#99");
	assert.equal(result.headSha, "a".repeat(40));
});

test("invalid inputs, missing auth, cancellation and provider errors produce no fallback or credential leak", async () => {
	let calls = 0;
	const github = client(() => {
		calls++;
		return Response.json({});
	});
	for (const name of [
		"owner",
		"../repo",
		"owner/..",
		"owner/repo?token=x",
		"https://api.github.com/owner/repo",
	])
		await assert.rejects(github.repository(name));
	await assert.rejects(github.feedback("owner/repo#0"));
	await assert.rejects(
		client(
			() => Response.json({}),
			async () => undefined
		).account(),
		/sign-in required/
	);
	await assert.rejects(
		client(
			() => Response.json({}),
			async () => {
				throw new Error("secret-token");
			}
		).account(),
		(error: Error) => !error.message.includes("secret-token")
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(github.account(controller.signal), /cancelled/);
	assert.equal(calls, 0);
	for (const status of [301, 401, 403, 404, 429, 500])
		await assert.rejects(
			client(() => new Response("secret-token", { status })).account(),
			(error: Error) => !error.message.includes("secret-token")
		);
	await assert.rejects(
		client(() => {
			throw new Error("secret-token");
		}).account(),
		/request failed/
	);
});

test("response byte limits and body cancellation bound malformed provider reads", async () => {
	await assert.rejects(
		client(() => new Response("x".repeat(4 * 1024 * 1024 + 1))).account(),
		/bounded read/
	);
	await assert.rejects(client(() => new Response("not-json-secret")).account(), /unreadable JSON/);
	const controller = new AbortController();
	const github = client(
		() =>
			new Response(
				new ReadableStream({
					start() {
						queueMicrotask(() => controller.abort());
					},
				})
			)
	);
	await assert.rejects(github.account(controller.signal), /cancelled/);
});

test("transport concurrency is capped at four; queued cancellation never dispatches", async () => {
	const releases: (() => void)[] = [];
	let active = 0;
	let peak = 0;
	let calls = 0;
	const github = client(async () => {
		calls++;
		active++;
		peak = Math.max(active, peak);
		await new Promise<void>((resolve) => releases.push(resolve));
		active--;
		return Response.json({ login: "viewer" });
	});
	const first = Array.from({ length: 4 }, () => github.account());
	await new Promise((resolve) => setTimeout(resolve, 0));
	const controller = new AbortController();
	const cancelled = github.account(controller.signal);
	const rejected = assert.rejects(cancelled, /cancelled/);
	const remaining = github.account();
	controller.abort();
	await rejected;
	assert.equal(calls, 4);
	for (const resolve of releases.splice(0)) resolve();
	await Promise.all(first);
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (const resolve of releases.splice(0)) resolve();
	await remaining;
	assert.equal(peak, 4);
	assert.equal(calls, 5);
});

test("pinned source reads exact repository/path/SHA with verbatim UTF-8 including BOM and line endings", async () => {
	const path = "src/a file.ts";
	const commitSha = "d".repeat(40);
	const content = "\ufeffconst value = 'é';\r\n\n";
	const result = await client((url) => {
		assert.equal(decodeURIComponent(url.pathname), `/repos/Owner/Repo/contents/${path}`);
		assert.equal(url.searchParams.get("ref"), commitSha);
		return Response.json({
			path,
			type: "file",
			size: Buffer.byteLength(content),
			encoding: "base64",
			content: Buffer.from(content).toString("base64"),
		});
	}).source({ repository: "Owner/Repo", path, commitSha });
	assert.deepEqual(result, { path, commitSha, status: "available", content });
});

test("pinned source returns missing only for a verified accessible commit, never for auth or invalid revision", async () => {
	const input = { repository: "Owner/Repo", path: "absent.ts", commitSha: "d".repeat(40) };
	assert.deepEqual(
		await client((url) =>
			url.pathname.includes("/git/commits/")
				? Response.json({ sha: input.commitSha })
				: new Response(null, { status: 404 })
		).source(input),
		{ path: input.path, commitSha: input.commitSha, status: "missing", content: null }
	);
	await assert.rejects(
		client(() => new Response(null, { status: 404 })).source(input),
		/not found or inaccessible/
	);
	await assert.rejects(
		client(() => new Response(null, { status: 403 })).source(input),
		/access denied/
	);
	await assert.rejects(
		client((url) =>
			url.pathname.includes("/git/commits/")
				? Response.json({ sha: "a".repeat(40) })
				: new Response(null, { status: 404 })
		).source(input),
		/different source commit/
	);
});

test("pinned source marks too-large and binary while rejecting malformed, non-file and mismatched content", async () => {
	const input = { repository: "Owner/Repo", path: "source.ts", commitSha: "d".repeat(40) };
	for (const [bytes, status] of [
		[Buffer.from([0, 1]), "binary"],
		[Buffer.from([255]), "binary"],
	] as const) {
		const result = await client(() =>
			Response.json({
				path: input.path,
				type: "file",
				size: bytes.length,
				encoding: "base64",
				content: bytes.toString("base64"),
			})
		).source(input);
		assert.equal(result.status, status);
		assert.equal(result.content, null);
	}
	assert.equal(
		(
			await client(() => Response.json({ path: input.path, type: "file", size: 300001 })).source(
				input
			)
		).status,
		"too-large"
	);
	for (const overrides of [
		{ path: "other.ts" },
		{ type: "dir" },
		{ type: "symlink" },
		{ encoding: "none" },
		{ content: "invalid-base64" },
		{ size: 8 },
	])
		await assert.rejects(
			client(() =>
				Response.json({
					path: input.path,
					type: "file",
					size: 1,
					encoding: "base64",
					content: "YQ==",
					...overrides,
				})
			).source(input)
		);
	await assert.rejects(
		client(() => {
			throw new Error("must not dispatch");
		}).source({ ...input, commitSha: "main" })
	);
	await assert.rejects(
		client(() => {
			throw new Error("must not dispatch");
		}).source({ ...input, path: "../source.ts" })
	);
});

test("createDraft rejects unrelated repositories and non-draft provider responses without retrying", async () => {
	for (const remote of [
		pull(),
		{ ...pull(), draft: true, base: { ...pull().base, repo: { full_name: "Other/Repo" } } },
	]) {
		let calls = 0;
		await assert.rejects(
			client(() => {
				calls++;
				return Response.json(remote);
			}).createDraft({
				repository: "Owner/Repo",
				base: "main",
				head: "change",
				title: "Title",
				body: "Body",
			})
		);
		assert.equal(calls, 1);
	}
});
