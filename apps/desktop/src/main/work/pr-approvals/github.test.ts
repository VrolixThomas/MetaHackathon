import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { ApprovalGitHub } from "./github";
import { actor, base, head, later, policy, terms } from "./test-support";

function providerHarness() {
	const control = {
		token: "private-token",
		epoch: 0,
		sha: head,
		check: "success",
		app: 42,
		state: "open",
		draft: false,
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
		user: { id: 8, login: "author" },
		base: { sha: control.base, ref: "main", repo: { full_name: "owner/repo" } },
		head: { sha: control.sha },
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
		if (path === "/user") data = actor;
		else if (path === "/repos/owner/repo") data = { permissions: { push: true } };
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
				user: actor,
			};
		} else throw new Error(`Unexpected provider request ${path}`);
		return Response.json(data);
	};
	const provider = new ApprovalGitHub(
		async () => control.token,
		() => control.epoch,
		transport
	);
	return { control, calls, provider, transport };
}
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
