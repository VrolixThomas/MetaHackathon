import assert from "node:assert/strict";
import { it } from "node:test";
import { PRApprovals, evaluatePolicy } from ".";
import {
	actor,
	at,
	deferred,
	harness,
	head,
	later,
	observation,
	policy,
	terms,
} from "./test-support";

it("requires a revision/digest-bound explicit confirmation and re-confirms every edit", async () => {
	const h = harness([]);
	const p = await h.service.draft({ sessionId: "s", terms });
	assert.equal(p.status, "draft");
	await h.service.tick();
	assert.equal(h.submitted.length, 0);
	await assert.rejects(
		h.service.confirm({ id: p.id, revision: p.revision, digest: "f".repeat(64), confirmed: true })
	);
	const edited = await h.service.draft({
		sessionId: "s",
		id: p.id,
		revision: p.revision,
		terms: { ...terms, action: "notify" },
	});
	assert.equal(edited.revision, 2);
	assert.equal(edited.confirmedAt, null);
	await assert.rejects(
		h.service.confirm({ id: p.id, revision: 1, digest: p.digest, confirmed: true })
	);
	await h.service.confirm({ id: edited.id, revision: 2, digest: edited.digest, confirmed: true });
	await h.service.tick();
	assert.equal(h.submitted.length, 0);
	await h.service.dispose();
});
it("performs two fresh evaluations, reserves once and preserves a real provider receipt", async () => {
	const h = harness();
	await h.service.tick();
	assert.equal(h.control.reads, 2);
	assert.equal(h.submitted.length, 1);
	assert.equal(h.submitted[0]?.head, head);
	assert.ok(h.p.attempt?.id);
	assert.equal(h.p.attempt?.receipt?.id, 99);
	assert.equal(h.p.status, "approved");
	await h.service.tick();
	await new PRApprovals(h.ports).tick();
	assert.equal(h.submitted.length, 1);
});
it("missing, pending, failing, duplicate or wrong-app check evidence blocks approval", async () => {
	for (const checks of [
		[],
		[{ name: "regression", appId: 42, passed: false, url: null }],
		[{ name: "regression", appId: 4, passed: true, url: null }],
		Array.from({ length: 2 }, () => ({ name: "regression", appId: 42, passed: true, url: null })),
	]) {
		const h = harness();
		h.control.observation.checks = checks;
		await h.service.tick();
		assert.equal(h.p.status, "monitoring");
		assert.equal(h.submitted.length, 0);
	}
});
it("observes check transitions without inventing execution", async () => {
	const h = harness();
	const check = h.control.observation.checks[0];
	assert.ok(check);
	check.passed = false;
	await h.service.tick();
	assert.equal(h.p.evaluation?.evidence[0]?.satisfied, false);
	check.passed = true;
	await h.service.tick();
	assert.equal(h.p.status, "approved");
});
it("enforces repository-required checks even if not mentioned in the policy", async () => {
	const h = harness();
	h.control.observation.required = [{ name: "security", appId: null }];
	await h.service.tick();
	assert.equal(h.submitted.length, 0);
	assert.equal(h.p.evaluation?.evidence.find((e) => e.condition === "security")?.satisfied, false);
});
it("returns a new check-only head or unrelated source change for renewed review", async () => {
	for (const change of [
		{ path: "src/unrelated.ts", status: "modified" },
		{ path: "src/fix.ts", status: "renamed" },
	]) {
		const h = harness();
		h.control.observation.headSha = later;
		h.control.observation.changes = [change];
		await h.service.tick();
		assert.equal(h.p.status, "needs-review");
		assert.equal(h.submitted.length, 0);
		assert.equal(h.state.notices[0]?.kind, "pr-approval");
	}
});
it("covers only exact full-file replacements, including byte-sensitive line endings", async () => {
	const p = policy({
		terms: {
			...terms,
			conditions: [
				...terms.conditions,
				{
					kind: "source",
					path: "src/fix.ts",
					expectedContent: "fixed\n",
					reason: "Fix discussed error handling",
				},
			],
		},
	});
	const o = observation({
		headSha: later,
		changes: [{ path: "src/fix.ts", status: "modified" }],
		sources: [{ path: "src/fix.ts", content: "fixed\n" }],
	});
	assert.equal(evaluatePolicy(p, o, at).outcome, "satisfied");
	const source = o.sources[0];
	assert.ok(source);
	source.content = "fixed\r\n";
	assert.equal(evaluatePolicy(p, o, at).outcome, "needs-review");
	o.changes.push({ path: "src/elsewhere.ts", status: "modified" });
	assert.equal(evaluatePolicy(p, o, at).outcome, "needs-review");
});
it("refuses changed base, force pushes, lost permissions, closed PRs and foreign actors", () => {
	for (const o of [
		observation({ baseSha: later }),
		observation({ descendant: false }),
		observation({ permitted: false }),
		observation({ open: false }),
		observation({ actor: { id: 8, login: "other" } }),
	])
		assert.equal(evaluatePolicy(policy(), o, at).outcome, "needs-review");
});
it("judgment is labeled inference and never authorizes approval", async () => {
	const h = harness([
		policy({
			terms: {
				...terms,
				conditions: [{ kind: "judgment", description: "Is error handling correct?" }],
			},
		}),
	]);
	await h.service.tick();
	assert.equal(h.p.status, "needs-review");
	assert.equal(h.p.evaluation?.evidence[0]?.kind, "inference");
	assert.equal(h.submitted.length, 0);
});
it("notification-only creates attention without GitHub writes", async () => {
	const h = harness([policy({ terms: { ...terms, action: "notify" } })]);
	await h.service.tick();
	assert.equal(h.p.status, "notified");
	assert.equal(h.submitted.length, 0);
	assert.equal(h.state.notices.length, 1);
	await h.service.tick();
	assert.equal(h.state.notices.length, 1);
});
it("revalidates all evidence before writing and rejects stale results", async () => {
	const h = harness();
	let read = 0;
	h.provider.observe = async () => {
		read++;
		return observation({
			headSha: read === 1 ? head : later,
			changes: read === 1 ? [] : [{ path: "new.ts", status: "added" }],
		});
	};
	await h.service.tick();
	assert.equal(h.submitted.length, 0);
	assert.equal(h.p.status, "needs-review");
});
it("durable revocation fences an in-flight evaluation and survives reopening", async () => {
	const h = harness();
	const d = deferred<ReturnType<typeof observation>>();
	h.provider.observe = () => d.promise;
	const job = h.service.tick();
	await new Promise((r) => setTimeout(r, 0));
	await h.service.revoke({ id: h.p.id, revision: 1 });
	d.resolve(observation());
	await job;
	assert.equal(h.p.status, "revoked");
	await new PRApprovals(h.ports).tick();
	assert.equal(h.submitted.length, 0);
});
it("account epochs fence late evaluation and do not expose notices to a new account", async () => {
	const h = harness();
	const d = deferred<ReturnType<typeof observation>>();
	h.provider.observe = () => d.promise;
	const job = h.service.tick();
	await new Promise((r) => setTimeout(r, 0));
	h.control.epoch++;
	h.control.connection = "e".repeat(64);
	h.control.account = { id: 8, login: "other" };
	await h.service.accountChanged();
	d.resolve(observation());
	await job;
	assert.equal(h.submitted.length, 0);
	assert.deepEqual(await h.service.list(), []);
	assert.equal(h.p.status, "needs-review");
	assert.equal(h.state.notices.length, 0);
});
it("restart under a different account never monitors or announces the previous account policy", async () => {
	const h = harness();
	h.control.connection = "e".repeat(64);
	await h.service.restore();
	await h.service.tick();
	assert.equal(h.p.status, "needs-review");
	assert.equal(h.submitted.length, 0);
	assert.equal(h.state.notices.length, 0);
	await h.service.dispose();
});
it("an uncertain write is durable and is never retried, including after restart", async () => {
	const h = harness();
	h.provider.approve = async (p, head, attempt, signal) => {
		h.submitted.push({ p, head, attempt, signal });
		throw new Error("Lost response after provider accepted");
	};
	await h.service.tick();
	assert.equal(h.p.status, "uncertain");
	assert.equal(h.p.attempt?.receipt, null);
	const reopen = new PRApprovals(h.ports);
	await reopen.restore();
	await reopen.tick();
	assert.equal(h.submitted.length, 1);
	await reopen.dispose();
});
it("a crash after durable write admission restores uncertain rather than replays", async () => {
	const h = harness([
		policy({
			status: "submitting",
			attempt: {
				id: "attempt",
				headSha: head,
				startedAt: new Date(at).toISOString(),
				receipt: null,
			},
		}),
	]);
	await h.service.restore();
	await h.service.tick();
	assert.equal(h.p.status, "uncertain");
	assert.equal(h.submitted.length, 0);
	await h.service.dispose();
});
it("expiry and sleep prevent evaluation; awake monitoring resumes after restart", async () => {
	const h = harness();
	h.control.awake = false;
	await h.service.tick();
	assert.equal(h.p.status, "paused");
	assert.equal(h.control.reads, 0);
	const reopen = new PRApprovals(h.ports);
	await reopen.restore();
	h.control.awake = true;
	await reopen.tick();
	assert.equal(h.p.status, "approved");
	await reopen.dispose();
	const expired = harness();
	expired.control.now += 86400001;
	await expired.service.tick();
	assert.equal(expired.p.status, "expired");
	assert.equal(expired.submitted.length, 0);
});
it("network errors retain offline state and recover without losing a successful policy", async () => {
	const h = harness();
	const original = h.provider.observe;
	h.provider.observe = async () => {
		throw new Error("offline");
	};
	await h.service.tick();
	assert.equal(h.p.status, "offline");
	assert.equal((await h.service.list()).length, 1);
	h.provider.observe = original;
	await h.service.tick();
	assert.equal(h.p.status, "approved");
});
it("offline revocation does not depend on a provider request", async () => {
	const h = harness();
	h.provider.account = async () => {
		throw new Error("offline");
	};
	await h.service.revoke({ id: h.p.id, revision: 1 });
	assert.equal(h.p.status, "revoked");
});
it("rejects missing review context, wrong-account edits and invalid expiry", async () => {
	const h = harness([]);
	h.ports.reviewed = async () => {
		throw new Error("No displayed PR");
	};
	await assert.rejects(h.service.draft({ sessionId: "s", terms }));
	assert.equal(h.state.approvalPolicies?.length, 0);
	const other = harness();
	other.control.account = { ...actor, id: 8 };
	await assert.rejects(other.service.draft({ sessionId: "s", terms, id: other.p.id, revision: 1 }));
	const expired = harness([]);
	await assert.rejects(
		expired.service.draft({
			sessionId: "s",
			terms: { ...terms, expiresAt: new Date(at - 1).toISOString() },
		})
	);
});
it("revocation retains an actual late receipt without reactivating the policy", async () => {
	const h = harness();
	const entered = deferred<void>();
	const receipt = deferred<{ id: number; url: string }>();
	h.provider.approve = async () => {
		entered.resolve();
		return receipt.promise;
	};
	const job = h.service.tick();
	await entered.promise;
	await h.service.revoke({ id: h.p.id, revision: 1 });
	receipt.resolve({ id: 3, url: "https://github.com/owner/repo/pull/1#pullrequestreview-3" });
	await job;
	assert.equal(h.p.status, "revoked");
	assert.equal(h.p.attempt?.receipt?.id, 3);
	assert.equal(h.state.notices.length, 0);
});
it("independent concurrent ticks submit only one review", async () => {
	const h = harness();
	await Promise.all([h.service.tick(), h.service.tick(), h.service.tick()]);
	assert.equal(h.submitted.length, 1);
});
it("beginning an edit fences an in-flight evaluation before gathering new context", async () => {
	const h = harness();
	const d = deferred<ReturnType<typeof observation>>();
	h.provider.observe = () => d.promise;
	const job = h.service.tick();
	await new Promise((r) => setTimeout(r, 0));
	await h.service.beginEdit({ id: h.p.id, revision: 1 });
	d.resolve(observation());
	await job;
	assert.equal(h.p.status, "needs-review");
	assert.equal(h.submitted.length, 0);
	assert.match(h.p.evaluation?.explanation ?? "", /Editing paused/);
	await assert.rejects(
		h.service.confirm({ id: h.p.id, revision: 1, digest: h.p.digest, confirmed: true })
	);
});
it("changed PR title, description, target or author context requires renewed consent", () => {
	assert.equal(
		evaluatePolicy(policy(), observation({ contextDigest: "f".repeat(64) }), at).outcome,
		"needs-review"
	);
});
it("expired drafts and human-review policies expose expiry without approving or announcing an unconfirmed draft", async () => {
	for (const status of ["draft", "needs-review"] as const) {
		const h = harness([
			policy({ status, confirmedAt: status === "draft" ? null : new Date(at).toISOString() }),
		]);
		h.control.now += 86400001;
		await h.service.tick();
		assert.equal(h.p.status, "expired");
		assert.equal(h.submitted.length, 0);
		assert.equal(h.state.notices.length, status === "draft" ? 0 : 1);
	}
});
it("temporary credential refresh outages preserve the policy for offline recovery", async () => {
	const h = harness();
	h.ports.connection = async () => {
		throw new Error("Refresh transport offline");
	};
	await h.service.tick();
	assert.equal(h.p.status, "offline");
	assert.equal(h.submitted.length, 0);
	h.ports.connection = async () => h.control.connection;
	await h.service.tick();
	assert.equal(h.p.status, "approved");
});

it("restart removes another account's saved approval notices before attention can claim them", async () => {
	const h = harness([policy({ terms: { ...terms, action: "notify" } })]);
	await h.service.tick();
	assert.equal(h.state.notices.length, 1);
	h.control.connection = "f".repeat(64);
	const reopen = new PRApprovals(h.ports);
	await reopen.restore();
	assert.equal(h.state.notices.length, 0);
	await reopen.dispose();
});

it("expiry at final durable admission prevents an approval attempt", async () => {
	const h = harness();
	const original = h.ports.update;
	h.ports.update = async (mutate) => {
		if (h.control.reads === 2) h.control.now = Date.parse(terms.expiresAt);
		return original(mutate);
	};
	await h.service.tick();
	assert.equal(h.p.status, "expired");
	assert.equal(h.p.attempt, null);
	assert.equal(h.submitted.length, 0);
});
it("expiry while notification evidence is in flight cannot publish satisfied notification", async () => {
	const h = harness([policy({ terms: { ...terms, action: "notify" } })]);
	h.provider.observe = async () => {
		h.control.now = Date.parse(terms.expiresAt);
		return observation();
	};
	await h.service.tick();
	assert.equal(h.p.status, "expired");
	assert.equal(h.p.evaluation, null);
	assert.equal(h.submitted.length, 0);
	assert.ok(h.state.notices.every((n) => !n.detail.includes("conditions hold")));
});
