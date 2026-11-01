import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { PRApprovals, policyDigest } from ".";
import { ApprovalPolicySchema } from "../../../shared/contracts";
import { ApprovalGitHub } from "./github";
import { actor, at, base, harness, head, later, policy, terms } from "./test-support";

function githubUser(identity: typeof actor) {
	return {
		...identity,
		name: "GitHub User",
		avatar_url: `https://avatars.githubusercontent.com/u/${identity.id}?v=4`,
		node_id: `U_${identity.id}`,
		html_url: `https://github.com/${identity.login}`,
		type: "User",
		site_admin: false,
	};
}
function providerHarness(mapResponse = (_path: string, data: unknown): unknown => data) {
	const control = {
		now: at,
		tokenReads: 0,
		beforeToken: () => {},
		beforeResponse: (_path: string) => {},
		token: "private-token",
		epoch: 0,
		sha: head,
		check: "success",
		app: 42,
		state: "open",
		draft: false,
		author: { id: 8, login: "author" },
		push: true,
		base,
		branchRequired: [] as { context: string; app_id: number | null }[],
		rulesRequired: [] as { context: string; integration_id: number | null }[],
		compareFiles: [{ filename: "src/fix.ts", status: "modified" }],
		source: "fixed\n",
		runHead: head,
		posts: 0,
	};
	const calls: { path: string; method: string; body: unknown; auth: string | null }[] = [];
	const remotePR = () => ({
		number: 1,
		title: "Real source",
		body: "PR intent",
		state: control.state,
		draft: control.draft,
		user: githubUser(control.author),
		base: {
			sha: control.base,
			ref: "main",
			repo: { full_name: "owner/repo", owner: githubUser(control.author), private: false },
		},
		head: { sha: control.sha, ref: "fix", user: githubUser(control.author) },
		html_url: "https://github.com/owner/repo/pull/1",
		merged: false,
		labels: [],
	});
	const transport: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const path = url.pathname + url.search;
		calls.push({
			path,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : null,
			auth: new Headers(init?.headers).get("Authorization"),
		});
		assert.equal(url.origin, "https://api.github.com");
		assert.equal(init?.redirect, "error");
		let data: unknown;
		if (path === "/user") data = githubUser(actor);
		else if (path === "/repos/owner/repo") data = { permissions: { push: control.push } };
		else if (path === "/repos/owner/repo/pulls/1") data = remotePR();
		else if (path.endsWith("/rules/branches/main"))
			data = control.rulesRequired.length
				? [
						{
							type: "required_status_checks",
							parameters: { required_status_checks: control.rulesRequired },
						},
					]
				: [];
		else if (path.endsWith("/branches/main"))
			data = {
				protected: control.branchRequired.length > 0,
				protection: {
					required_status_checks: {
						contexts: control.branchRequired.map((c) => c.context),
						checks: control.branchRequired,
					},
				},
			};
		else if (path.includes("/compare/"))
			data = { status: "ahead", merge_base_commit: { sha: head }, files: control.compareFiles };
		else if (path.includes("/check-runs?"))
			data = {
				total_count: 1,
				check_runs: [
					{
						id: 1,
						name: "regression",
						head_sha: control.runHead,
						status: control.check === "pending" ? "in_progress" : "completed",
						conclusion: control.check === "pending" ? null : control.check,
						html_url: "https://github.com/owner/repo/actions/runs/1",
						app: { id: control.app },
					},
				],
			};
		else if (path.includes("/statuses?")) data = [];
		else if (path.includes("/git/trees/"))
			data = {
				truncated: false,
				tree: [
					{ path: "src", mode: "040000", type: "tree", sha: "f".repeat(40) },
					{
						path: "fix.ts",
						mode: "100644",
						type: "blob",
						sha: createHash("sha1")
							.update(`blob ${Buffer.byteLength(control.source)}\0`)
							.update(control.source)
							.digest("hex"),
					},
				],
			};
		else if (path.includes("/contents/"))
			data = {
				type: "file",
				path: "src/fix.ts",
				size: Buffer.byteLength(control.source),
				encoding: "base64",
				content: Buffer.from(control.source).toString("base64"),
			};
		else if (path.endsWith("/reviews")) {
			control.posts++;
			data = {
				id: 99,
				html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-99",
				commit_id: control.sha,
				state: "APPROVED",
				user: githubUser(actor),
				body: "Approved under MuseFocus delegation",
				author_association: "MEMBER",
				submitted_at: "2026-11-01T12:00:00Z",
				_links: { html: { href: "https://github.com/owner/repo/pull/1#pullrequestreview-99" } },
			};
		} else throw new Error(`Unexpected provider request ${path}`);
		control.beforeResponse(path);
		return Response.json(mapResponse(path, data));
	};
	const provider = new ApprovalGitHub(
		async () => {
			control.tokenReads++;
			control.beforeToken();
			return control.token;
		},
		() => control.epoch,
		transport,
		() => control.now
	);
	return { control, calls, provider, transport };
}
it("normalizes realistic GitHub user, PR and review envelopes while keeping shared actors strict", async () => {
	const h = providerHarness();
	assert.equal(ApprovalPolicySchema.shape.actor.safeParse(githubUser(actor)).success, false);
	assert.deepEqual(await h.provider.account(AbortSignal.timeout(5000)), actor);
	const p = policy();
	p.contextDigest = await h.provider.pin(p.pr, AbortSignal.timeout(5000));
	const observed = await h.provider.observe(p, AbortSignal.timeout(5000));
	assert.deepEqual(observed.actor, actor);
	assert.equal(observed.permitted, true);
	assert.deepEqual(await h.provider.approve(p, head, "attempt", AbortSignal.timeout(5000)), {
		id: 99,
		url: "https://github.com/owner/repo/pull/1#pullrequestreview-99",
	});
	assert.equal(h.control.posts, 1);
});
it("rejects invalid actor identities inside permissive provider envelopes", async () => {
	for (const invalid of [
		{ id: 0 },
		{ id: "7" },
		{ id: null },
		{ id: 1.5 },
		{ login: "" },
		{ login: null },
		{ login: "x".repeat(101) },
	]) {
		for (const boundary of ["account", "pull", "review"] as const) {
			const h = providerHarness((path, data) => {
				if (boundary === "account" && path === "/user") return { ...githubUser(actor), ...invalid };
				if (
					(boundary === "pull" && path === "/repos/owner/repo/pulls/1") ||
					(boundary === "review" && path.endsWith("/reviews"))
				)
					return { ...(data as object), user: { ...githubUser(actor), ...invalid } };
				return data;
			});
			const p = policy();
			if (boundary === "review")
				p.contextDigest = await h.provider.pin(p.pr, AbortSignal.timeout(5000));
			await assert.rejects(
				boundary === "account"
					? h.provider.account(AbortSignal.timeout(5000))
					: boundary === "pull"
						? h.provider.pin(p.pr, AbortSignal.timeout(5000))
						: h.provider.approve(p, head, "attempt", AbortSignal.timeout(5000)),
				{ name: "ZodError" }
			);
			assert.equal(h.control.posts, boundary === "review" ? 1 : 0);
		}
	}
});
it("reads actual account, permissions, branch rules, head checks and source, then sends head-bound APPROVE", async () => {
	const h = providerHarness();
	h.control.sha = later;
	h.control.runHead = later;
	h.control.branchRequired = [{ context: "classic", app_id: 42 }];
	h.control.rulesRequired = [{ context: "ruleset", integration_id: 17 }];
	const p = policy({
		terms: {
			...terms,
			conditions: [
				...terms.conditions,
				{ kind: "source", path: "src/fix.ts", expectedContent: "fixed\n", reason: "discussed fix" },
			],
		},
	});
	p.contextDigest = await h.provider.pin({ ...p.pr, headSha: later }, AbortSignal.timeout(5000));
	const o = await h.provider.observe(p, AbortSignal.timeout(5000));
	assert.equal(o.headSha, later);
	assert.equal(o.sources[0]?.content, "fixed\n");
	assert.equal(o.descendant, true);
	assert.deepEqual(o.required, [
		{ name: "ruleset", appId: 17 },
		{ name: "classic", appId: 42 },
	]);
	assert.equal(h.control.posts, 0);
	const receipt = await h.provider.approve(p, later, "attempt-1", AbortSignal.timeout(5000));
	assert.equal(receipt.id, 99);
	const post = h.calls.find((c) => c.method === "POST");
	assert.equal(post?.path, "/repos/owner/repo/pulls/1/reviews");
	assert.deepEqual(post?.body, {
		event: "APPROVE",
		commit_id: later,
		body: `Approved under MuseFocus delegation ${p.id}, revision 1.\nAttempt: attempt-1`,
	});
	assert.ok(h.calls.every((c) => c.auth === "Bearer private-token"));
});
it("does not post when the head/base/state has changed at provider preflight", async () => {
	for (const change of [{ sha: later }, { base: later }, { state: "closed" }, { draft: true }]) {
		const h = providerHarness();
		Object.assign(h.control, change);
		await assert.rejects(h.provider.approve(policy(), head, "attempt", AbortSignal.timeout(5000)));
		assert.equal(h.control.posts, 0);
	}
});
it("keeps pending/failed checks unsuccessful and rejects check head mismatches", async () => {
	const h = providerHarness();
	h.control.check = "pending";
	assert.equal(
		(await h.provider.observe(policy(), AbortSignal.timeout(5000))).checks[0]?.passed,
		false
	);
	h.control.check = "failure";
	assert.equal(
		(await h.provider.observe(policy(), AbortSignal.timeout(5000))).checks[0]?.passed,
		false
	);
	h.control.runHead = later;
	await assert.rejects(h.provider.observe(policy(), AbortSignal.timeout(5000)));
});
it("refuses oversized comparisons rather than treating truncated scope as complete", async () => {
	const h = providerHarness();
	h.control.sha = later;
	h.control.runHead = later;
	h.control.compareFiles = Array.from({ length: 300 }, (_, i) => ({
		filename: `file-${i}`,
		status: "modified",
	}));
	await assert.rejects(h.provider.observe(policy(), AbortSignal.timeout(5000)));
	assert.equal(h.control.posts, 0);
});
it("credential replacement during provider preflight cannot switch the posting account", async () => {
	const h = providerHarness();
	let calls = 0;
	const provider = new ApprovalGitHub(
		async () => {
			if (++calls === 4) {
				h.control.token = "new-token";
				h.control.epoch++;
			}
			return h.control.token;
		},
		() => h.control.epoch,
		h.transport
	);
	await assert.rejects(provider.approve(policy(), head, "attempt", AbortSignal.timeout(5000)));
	assert.equal(h.control.posts, 0);
});
it("late account epochs and aborts fence provider writes", async () => {
	const h = providerHarness();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(h.provider.approve(policy(), head, "attempt", controller.signal));
	assert.equal(h.calls.length, 0);
	const foreign = new ApprovalGitHub(
		async () => h.control.token,
		() => h.control.epoch,
		async (input, init) => {
			const response = await h.transport(input, init);
			if (String(input).endsWith("/user")) h.control.epoch++;
			return response;
		}
	);
	await assert.rejects(foreign.approve(policy(), head, "attempt", AbortSignal.timeout(5000)));
	assert.equal(h.control.posts, 0);
});
it("missing current GitHub access fails closed without a provider request", async () => {
	const h = providerHarness();
	const provider = new ApprovalGitHub(
		async () => undefined,
		() => 0,
		h.transport
	);
	await assert.rejects(provider.observe(policy(), AbortSignal.timeout(5000)));
	assert.equal(h.calls.length, 0);
});

it("expiry during provider PR preflight prevents POST and durably expires the admitted attempt", async () => {
	const remote = providerHarness();
	const h = harness();
	h.provider.approve = remote.provider.approve.bind(remote.provider);
	h.p.contextDigest = await remote.provider.pin(h.p.pr, AbortSignal.timeout(5000));
	// Rebind the exact stored policy digest after pinning actual controlled provider context.
	h.p.digest = policyDigest(h.p);
	h.control.observation.contextDigest = h.p.contextDigest;
	remote.control.beforeResponse = (path) => {
		if (path === "/repos/owner/repo/pulls/1") {
			remote.control.now = Date.parse(terms.expiresAt);
			h.control.now = remote.control.now;
		}
	};
	await h.service.tick();
	assert.equal(remote.control.posts, 0);
	assert.equal(h.p.status, "expired");
	assert.ok(h.p.attempt);
	assert.equal(h.p.attempt.receipt, null);
	const reopened = new PRApprovals(h.ports);
	await reopened.restore();
	await reopened.tick();
	assert.equal(remote.control.posts, 0);
	assert.equal(h.p.status, "expired");
	await reopened.dispose();
});
it("expiry during the final credential await fences POST independently of coordinator guards", async () => {
	const h = providerHarness();
	const p = policy();
	p.contextDigest = await h.provider.pin(p.pr, AbortSignal.timeout(5000));
	const initial = h.control.tokenReads;
	h.control.beforeToken = () => {
		// session token, /user, PR preflight, then the final POST credential fence.
		if (h.control.tokenReads === initial + 4) h.control.now = Date.parse(p.terms.expiresAt);
	};
	await assert.rejects(
		h.provider.approve(p, head, "attempt", AbortSignal.timeout(5000)),
		/expired/
	);
	assert.equal(h.calls.filter((c) => c.path === "/repos/owner/repo/pulls/1").length, 2);
	assert.equal(h.control.posts, 0);
});
it("an account epoch change while capturing the initial credential rejects the operation", async () => {
	const h = providerHarness();
	h.control.beforeToken = () => {
		h.control.epoch++;
	};
	await assert.rejects(
		h.provider.approve(policy(), head, "attempt", AbortSignal.timeout(5000)),
		/account changed/
	);
	assert.equal(h.calls.length, 0);
});

it("revocation during final credential preflight fences the admitted write", async () => {
	const remote = providerHarness();
	const h = harness();
	h.provider.approve = remote.provider.approve.bind(remote.provider);
	h.p.contextDigest = await remote.provider.pin(h.p.pr, AbortSignal.timeout(5000));
	h.p.digest = policyDigest(h.p);
	h.control.observation.contextDigest = h.p.contextDigest;
	const initial = remote.control.tokenReads;
	let revoked: Promise<void> | undefined;
	remote.control.beforeToken = () => {
		if (remote.control.tokenReads === initial + 4)
			revoked = h.service.revoke({ id: h.p.id, revision: h.p.revision });
	};
	await h.service.tick();
	await revoked;
	assert.ok(revoked);
	assert.equal(remote.control.posts, 0);
	assert.equal(h.p.status, "revoked");
	assert.ok(h.p.attempt);
});

it("own and read-only PRs notify on actual observed checks while automatic approval stays blocked", async () => {
	for (const access of ["own", "read-only"] as const) {
		for (const action of ["notify", "approve"] as const) {
			const remote = providerHarness();
			if (access === "own") remote.control.author = actor;
			else remote.control.push = false;
			const h = harness([
				policy({
					pr: { ...policy().pr, author: remote.control.author.login },
					terms: { ...terms, action },
				}),
			]);
			h.p.contextDigest = await remote.provider.pin(h.p.pr, AbortSignal.timeout(5000));
			h.p.digest = policyDigest(h.p);
			h.provider.observe = remote.provider.observe.bind(remote.provider);
			h.provider.approve = remote.provider.approve.bind(remote.provider);
			await h.service.tick();
			assert.equal(h.p.status, action === "notify" ? "notified" : "needs-review");
			assert.equal(remote.control.posts, 0);
			assert.equal(h.p.attempt, null);
			assert.equal(h.state.notices.length, 1);
			if (action === "notify") {
				assert.equal(h.p.evaluation?.outcome, "satisfied");
				assert.equal(h.p.evaluation.evidence[0]?.providerId, 1);
				assert.match(h.state.notices[0]?.detail ?? "", /Notification only/);
			}
		}
	}
});
it("notify-only still blocks failed checks, changed scope and a foreign account without approval permission", async () => {
	for (const change of ["failed-check", "scope", "account"] as const) {
		const remote = providerHarness();
		remote.control.push = false;
		if (change === "failed-check") remote.control.check = "failure";
		const h = harness([policy({ terms: { ...terms, action: "notify" } })]);
		h.p.contextDigest = await remote.provider.pin(h.p.pr, AbortSignal.timeout(5000));
		h.p.digest = policyDigest(h.p);
		if (change === "scope") h.p.contextDigest = "f".repeat(64);
		if (change === "account") h.p.actor = { id: 99, login: "foreign" };
		h.p.digest = policyDigest(h.p);
		h.provider.observe = remote.provider.observe.bind(remote.provider);
		await h.service.tick();
		assert.equal(h.p.status, change === "failed-check" ? "monitoring" : "needs-review");
		assert.equal(remote.control.posts, 0);
		assert.equal(h.p.attempt, null);
		assert.ok(h.state.notices.every((n) => !n.detail.includes("conditions hold")));
	}
});
