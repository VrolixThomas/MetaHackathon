import assert from "node:assert/strict";
import { it } from "node:test";
import { policy } from "../../main/work/pr-approvals/test-support";
import { ApprovalDialogLifecycle } from "./dialog-lifecycle";

function setup() {
	const lifecycle = new ApprovalDialogLifecycle();
	const draft = policy({ status: "draft", confirmedAt: null });
	const pending = {
		sessionId: "session",
		id: draft.id,
		revision: draft.revision,
		digest: draft.digest,
	};
	const confirmed = {
		...draft,
		status: "monitoring" as const,
		confirmedAt: new Date().toISOString(),
	};
	assert.deepEqual(lifecycle.observe(pending, [draft], true), { kind: "open", id: draft.id });
	return { lifecycle, draft, pending, confirmed };
}

it("releases an automatically presented exact confirmed proposal and retains saved metadata", () => {
	const { lifecycle, draft, confirmed } = setup();
	assert.equal(lifecycle.observe(null, [draft], true), null); // shown is not confirmed
	assert.deepEqual(lifecycle.observe(null, [confirmed], true), { kind: "close" });
	assert.equal(lifecycle.observe(null, [confirmed], true), null);
	assert.equal(confirmed.status, "monitoring");
});

it("manual inspection, editing or consent keeps ownership across pending and confirmation polls", () => {
	const { lifecycle, draft, pending, confirmed } = setup();
	lifecycle.manual();
	assert.equal(lifecycle.observe(pending, [draft], true), null);
	assert.equal(lifecycle.observe(null, [confirmed], true), null);
	lifecycle.close();
	lifecycle.manual(); // reopen saved policy
	assert.equal(lifecycle.observe(null, [confirmed], true), null);
});

it("never closes on missing, failed, stale, different-account or unconfirmed metadata", () => {
	for (const change of [
		{ revision: 2 },
		{ digest: "f".repeat(64) },
		{ connectionId: "f".repeat(64) },
		{ confirmedAt: null },
		{ status: "draft" },
		{ status: "uncertain" },
		{ status: "needs-review" },
		{ status: "revoked" },
		{ status: "expired" },
		{ status: "paused" },
		{ status: "offline" },
	] as const) {
		const { lifecycle, confirmed } = setup();
		assert.equal(lifecycle.observe(null, [{ ...confirmed, ...change }], true), null);
	}
	const { lifecycle, confirmed, pending } = setup();
	assert.equal(lifecycle.observe(null, [], true), null);
	assert.equal(
		lifecycle.observe(
			null,
			[{ ...confirmed, pr: { ...confirmed.pr, headSha: "f".repeat(40) } }],
			true
		),
		null
	);
	assert.equal(lifecycle.observe(pending, [confirmed], true), null);
});

it("does not open while unavailable and tracks the replacement proposal rather than an older confirmation", () => {
	const { lifecycle, draft, pending, confirmed } = setup();
	lifecycle.close();
	assert.equal(lifecycle.observe(pending, [draft], false), null);
	assert.equal(lifecycle.observe(null, [confirmed], true), null);
	const next = { ...draft, id: "next" };
	assert.deepEqual(lifecycle.observe({ ...pending, id: next.id }, [next], true), {
		kind: "open",
		id: "next",
	});
	assert.equal(lifecycle.observe(null, [confirmed, next], true), null);
	assert.deepEqual(
		lifecycle.observe(
			null,
			[{ ...next, confirmedAt: confirmed.confirmedAt, status: "notified" }],
			true
		),
		{ kind: "close" }
	);
});
