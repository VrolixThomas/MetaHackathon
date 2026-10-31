import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePRFixViewTarget } from "../../shared/contracts";
import { loadedReviewMatchesFix } from "./model";
import { deferred, fixDetail, harness, stamp } from "./test-support";

test("empty startup performs no calls; explicit list and exact file reads use bounded typed routes", async () => {
	const h = harness();
	assert.equal(h.calls.length, 0);
	assert.deepEqual(h.controller.store.getState().items, []);
	await h.controller.poll();
	await h.controller.ensureTarget("fix-1");
	assert.equal(h.controller.store.getState().loadedTarget, "fix-1");
	assert.equal(h.controller.store.getState().selectedPath, "src/main.ts");
	const target = encodePRFixViewTarget({ id: "fix-1", path: "empty.test.ts" });
	await h.controller.ensureTarget(target);
	assert.equal(h.controller.store.getState().selectedPath, "empty.test.ts");
	assert.equal(h.controller.store.getState().loadedTarget, target);
	assert.deepEqual(
		h.calls.map((c) => [c.type, c.path, c.input]),
		[
			["query", "prFixes.list", {}],
			["query", "prFixes.detail", { id: "fix-1" }],
			["query", "prFixes.detail", { id: "fix-1" }],
		]
	);
	h.controller.dispose();
});

test("ensureTarget refreshes same id and removes positive loaded state while a refresh is pending", async () => {
	const next = deferred<unknown>();
	let delayed = false;
	const h = harness((path) => (path === "prFixes.detail" && delayed ? next.promise : undefined));
	await h.controller.ensureTarget("fix-1");
	delayed = true;
	const refresh = h.controller.ensureTarget("fix-1");
	assert.equal(h.controller.store.getState().loadedTarget, null);
	assert.equal(h.controller.store.getState().detail, null);
	next.resolve(h.detail());
	await refresh;
	assert.equal(h.calls.length, 2);
	assert.equal(h.controller.store.getState().loadedTarget, "fix-1");
});

test("explicit ensureTarget during a quiet poll waits for that read and retires cached source markers", async () => {
	const pending = deferred<unknown>();
	let delayed = false;
	const h = harness((path) => (path === "prFixes.detail" && delayed ? pending.promise : undefined));
	await h.controller.ensureTarget("fix-1");
	delayed = true;
	const polling = h.controller.poll();
	for (
		let tick = 0;
		tick < 20 && h.calls.filter((call) => call.path === "prFixes.detail").length < 2;
		tick++
	)
		await Promise.resolve();
	assert.equal(h.calls.filter((call) => call.path === "prFixes.detail").length, 2);
	const fresh = h.controller.ensureTarget("fix-1");
	assert.equal(h.controller.store.getState().loadedTarget, null);
	pending.resolve(h.detail());
	await Promise.all([polling, fresh]);
	assert.equal(h.calls.filter((call) => call.path === "prFixes.detail").length, 2);
	assert.equal(h.controller.store.getState().loadedTarget, "fix-1");
});

test("invalid/noncanonical targets and files outside the actual candidate cannot be acknowledged", async () => {
	const h = harness();
	for (const id of [
		"%broken",
		"fix-1?file=..%2Fsecret",
		"fix-1?file=missing.ts",
		"fix-1?file=src%2Fmain.ts?file=x",
	]) {
		await assert.rejects(h.controller.ensureTarget(id));
		assert.equal(h.controller.store.getState().loadedTarget, null);
	}
});

test("wrong job, head, base, original source, file identity or duplicate paths fail closed", async () => {
	const changes = [
		(detail: ReturnType<typeof fixDetail>) => {
			if (detail.review) detail.review.job.id = "other-job";
		},
		(detail: ReturnType<typeof fixDetail>) => {
			if (detail.review) detail.review.job.headSha = "d".repeat(40);
		},
		(detail: ReturnType<typeof fixDetail>) => {
			detail.fix.baseSha = "d".repeat(40);
		},
		(detail: ReturnType<typeof fixDetail>) => {
			if (detail.review?.job.feedback) detail.review.job.feedback.body = "Changed feedback";
		},
		(detail: ReturnType<typeof fixDetail>) => {
			const file = detail.review?.files[0];
			assert.ok(file);
			file.head.commitSha = "d".repeat(40);
		},
		(detail: ReturnType<typeof fixDetail>) => {
			const review = detail.review;
			assert.ok(review);
			const file = review.files[0];
			assert.ok(file);
			review.files.push(file);
		},
	];
	for (const change of changes) {
		const detail = fixDetail();
		change(detail);
		assert.equal(loadedReviewMatchesFix(detail), false);
		const h = harness((path) => (path === "prFixes.detail" ? detail : undefined));
		await assert.rejects(h.controller.ensureTarget("fix-1"));
		assert.equal(h.controller.store.getState().detail, null);
		assert.equal(h.controller.store.getState().loadedTarget, null);
	}
});

test("immutable source revisions cannot silently change under a known fix id", async () => {
	const h = harness();
	await h.controller.poll();
	const changed = fixDetail();
	changed.fix.feedback.body = "Edited original feedback";
	if (changed.review) changed.review.job.feedback = changed.fix.feedback;
	h.setDetail(changed);
	await assert.rejects(h.controller.ensureTarget("fix-1"));
	assert.equal(h.controller.store.getState().detail, null);
});

test("out-of-order exact file reads cannot replace a newer selected file", async () => {
	const first = deferred<unknown>();
	const second = deferred<unknown>();
	let reads = 0;
	const h = harness((path) =>
		path === "prFixes.detail" ? (++reads === 1 ? first.promise : second.promise) : undefined
	);
	const old = h.controller.ensureTarget("fix-1");
	const observedOld = assert.rejects(old);
	const target = encodePRFixViewTarget({ id: "fix-1", path: "empty.test.ts" });
	const current = h.controller.ensureTarget(target);
	second.resolve(fixDetail());
	await current;
	first.resolve(fixDetail());
	await observedOld;
	assert.equal(h.controller.store.getState().loadedTarget, target);
	assert.equal(h.controller.store.getState().selectedPath, "empty.test.ts");
});

test("actor reset clears all data synchronously and retires late list/detail responses", async () => {
	for (const path of ["prFixes.list", "prFixes.detail"]) {
		const pending = deferred<unknown>();
		const h = harness((read) => (read === path ? pending.promise : undefined));
		const work =
			path === "prFixes.list"
				? h.controller.poll()
				: h.controller.ensureTarget("fix-1").catch(() => {});
		h.setActor("actor-2");
		h.controller.reset();
		assert.equal(h.controller.store.getState().detail, null);
		assert.deepEqual(h.controller.store.getState().items, []);
		pending.resolve(path === "prFixes.list" ? [fixDetail().fix] : fixDetail());
		await work;
		assert.equal(h.calls.length, 0, "Reset before dispatch prevents retired IO");
		assert.equal(h.controller.store.getState().loadedTarget, null);
		assert.deepEqual(h.controller.store.getState().items, []);
	}
});

test("actor reader fences responses even if an account reset notification has not run yet", async () => {
	const pending = deferred<unknown>();
	const h = harness((path) => (path === "prFixes.detail" ? pending.promise : undefined));
	const work = h.controller.ensureTarget("fix-1");
	const rejected = assert.rejects(work);
	h.setActor("actor-2");
	pending.resolve(fixDetail());
	await rejected;
	assert.equal(h.controller.store.getState().detail, null);
	assert.equal(h.controller.store.getState().busy, false);
});

test("background admission is explicit, click-locked and request identity survives an unknown response", async () => {
	let fail = true;
	const h = harness((path) => {
		if (path === "prFixes.start" && fail) return Promise.reject(new Error("Response lost"));
		return undefined;
	});
	const input = { prId: "owner/repo#7", feedbackId: "feedback-7" };
	await h.controller.start(input);
	fail = false;
	const result = await h.controller.start(input);
	assert.ok(result);
	assert.equal(result.id, "new-fix-1");
	const starts = h.calls.filter((call) => call.path === "prFixes.start");
	assert.deepEqual(starts[0]?.input, starts[1]?.input);
	assert.equal(
		h.calls.some((call) => /hub|publish|apply|merge|send/.test(call.path)),
		false
	);
	const pending = deferred<unknown>();
	const lock = harness((path) => (path === "prFixes.start" ? pending.promise : undefined));
	const one = lock.controller.start(input);
	assert.equal(await lock.controller.start(input), null);
	pending.resolve(fixDetail("new-fix-1").fix);
	await one;
	assert.equal(lock.calls.length, 1);
});

test("older list reads cannot erase a newly admitted candidate", async () => {
	const pending = deferred<unknown>();
	const h = harness((path) => (path === "prFixes.list" ? pending.promise : undefined));
	const old = h.controller.poll();
	await h.controller.start({ prId: "owner/repo#7", feedbackId: "feedback-7" });
	pending.resolve([]);
	await old;
	assert.equal(h.controller.store.getState().items[0]?.id, "new-fix-1");
});

test("local review marker requires the exact loaded candidate id/head/base and uses only reviewed RPC", async () => {
	const h = harness();
	assert.equal(await h.controller.markReviewed("fix-1", "c".repeat(40)), null);
	await h.controller.ensureTarget("fix-1");
	assert.equal(await h.controller.markReviewed("wrong", "c".repeat(40)), null);
	assert.equal(await h.controller.markReviewed("fix-1", "d".repeat(40)), null);
	const result = await h.controller.markReviewed("fix-1", "c".repeat(40));
	assert.equal(result?.reviewedAt, stamp);
	assert.deepEqual(h.calls.find((call) => call.path === "prFixes.reviewed")?.input, {
		id: "fix-1",
		headSha: "c".repeat(40),
		confirmed: true,
	});
	assert.equal(h.controller.store.getState().detail?.fix.publication, "not-published");
});

test("missing review, needs-input and stale reviewed receipts never fabricate a local review", async () => {
	for (const phase of ["needs-input", "ready"] as const) {
		const h = harness();
		h.setDetail({ fix: { ...h.detail().fix, phase }, review: null });
		await h.controller.ensureTarget("fix-1");
		assert.equal(await h.controller.markReviewed("fix-1", "c".repeat(40)), null);
		assert.equal(
			h.calls.some((call) => call.path === "prFixes.reviewed"),
			false
		);
	}
	const h = harness((path) =>
		path === "prFixes.reviewed"
			? { ...fixDetail().fix, headSha: "d".repeat(40), reviewedAt: stamp }
			: undefined
	);
	await h.controller.ensureTarget("fix-1");
	assert.equal(await h.controller.markReviewed("fix-1", "c".repeat(40)), null);
	assert.equal(h.controller.store.getState().detail?.fix.reviewedAt, null);
});

test("cancellation displays the actual refreshed state; dispose retires pending reads", async () => {
	const h = harness();
	await h.controller.ensureTarget("fix-1");
	await h.controller.cancel("fix-1");
	assert.equal(h.controller.store.getState().detail?.fix.phase, "interrupted");
	assert.equal(h.controller.store.getState().detail?.review, null);
	const pending = deferred<unknown>();
	const late = harness((path) => (path === "prFixes.detail" ? pending.promise : undefined));
	const work = late.controller.ensureTarget("fix-1");
	const rejected = assert.rejects(work);
	late.controller.dispose();
	pending.resolve(fixDetail());
	await rejected;
	assert.equal(late.controller.store.getState().detail, null);
});
