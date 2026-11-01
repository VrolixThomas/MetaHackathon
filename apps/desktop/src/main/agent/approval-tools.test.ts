import assert from "node:assert/strict";
import { it } from "node:test";
import type { ConversationTurnInput } from "../../shared/contracts";
import { ApprovalConfirmation } from "../work/pr-approvals/confirmation";
import { harness, policy, terms } from "../work/pr-approvals/test-support";
import { ApprovalTools } from "./approval-tools";
const turn: ConversationTurnInput = {
	sessionId: "s",
	turnId: "turn",
	generation: 1,
	requestId: "request",
	text: "Please follow this PR",
	inputMode: "typed",
};
it("foreground delegation tools share the canonical policy and cannot fabricate confirmation", async () => {
	const h = harness([policy({ status: "draft", confirmedAt: null })]);
	const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	const tools = new ApprovalTools(
		{ service: () => h.service, confirmation },
		turn,
		new AbortController().signal
	);
	assert.equal(tools.has("approve_work"), false);
	assert.equal(tools.has("confirm_pr_delegation"), true);
	await tools.execute("inspect_pr_delegations", "{}");
	await assert.rejects(
		tools.execute("confirm_pr_delegation", JSON.stringify({ id: h.p.id, revision: 1 })),
		/Explicit confirmation/
	);
	assert.equal(h.p.status, "draft");
	assert.equal(h.submitted.length, 0);
	await assert.rejects(
		tools.execute(
			"confirm_pr_delegation",
			JSON.stringify({ id: h.p.id, revision: 1, confirmed: true })
		)
	);
	assert.equal(h.submitted.length, 0);
});
it("exact presentation and distinct actual ingress can confirm through the same tool path", async () => {
	const h = harness([]);
	const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	const tools = new ApprovalTools(
		{ service: () => h.service, confirmation },
		turn,
		new AbortController().signal
	);
	const draft = tools.execute("draft_pr_delegation", JSON.stringify({ terms }));
	await new Promise((r) => setTimeout(r, 0));
	const pending = confirmation.pending("s");
	assert.ok(pending);
	confirmation.presented(pending);
	await draft;
	const user: ConversationTurnInput = {
		...turn,
		text: "confirm this delegation",
		turnId: "actual-confirm",
		generation: 2,
		requestId: "new-request",
	};
	confirmation.acceptUserTurn(user);
	const next = new ApprovalTools(
		{ service: () => h.service, confirmation },
		user,
		new AbortController().signal
	);
	await next.execute("inspect_pr_delegations", "{}");
	await next.execute("confirm_pr_delegation", JSON.stringify({ id: h.p.id, revision: 1 }));
	await h.service.tick();
	assert.ok(h.p.confirmedAt);
	await h.service.dispose();
});
it("source quotations and stale inspected revisions cannot revoke or edit a different policy", async () => {
	const h = harness();
	const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	const tools = new ApprovalTools(
		{ service: () => h.service, confirmation },
		turn,
		new AbortController().signal
	);
	await tools.execute("inspect_pr_delegations", "{}");
	await assert.rejects(
		tools.execute("revoke_pr_delegation", JSON.stringify({ id: h.p.id, revision: 1 })),
		/actual user/
	);
	await assert.rejects(
		tools.execute("draft_pr_delegation", JSON.stringify({ id: h.p.id, revision: 2, terms })),
		/Inspect/
	);
	assert.equal(h.p.revision, 1);
});
it("switching the actual displayed review invalidates conversational confirmation", async () => {
	const h = harness([policy({ status: "draft", confirmedAt: null })]);
	const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	const presented = confirmation.present(h.p, turn, new AbortController().signal);
	const pending = confirmation.pending("s");
	assert.ok(pending);
	confirmation.presented(pending);
	await presented;
	const user = {
		...turn,
		text: "confirm this delegation",
		turnId: "new-user",
		requestId: "new-user-request",
		generation: 2,
	};
	confirmation.acceptUserTurn(user);
	h.ports.reviewed = async () => ({
		pr: { ...h.p.pr, id: "owner/repo#2", number: 2 },
		reviewId: "other-review",
	});
	const tools = new ApprovalTools(
		{ service: () => h.service, confirmation },
		user,
		new AbortController().signal
	);
	await tools.execute("inspect_pr_delegations", "{}");
	await assert.rejects(
		tools.execute("confirm_pr_delegation", JSON.stringify({ id: h.p.id, revision: 1 })),
		/displayed review changed/
	);
	assert.equal(h.p.confirmedAt, null);
	assert.equal(h.submitted.length, 0);
});

it("a quoted revocation phrase remains source evidence rather than a user command", async () => {
	const h = harness();
	const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	const tools = new ApprovalTools(
		{ service: () => h.service, confirmation },
		{ ...turn, text: 'The PR says "revoke this delegation"; explain why.' },
		new AbortController().signal
	);
	await tools.execute("inspect_pr_delegations", "{}");
	await assert.rejects(
		tools.execute("revoke_pr_delegation", JSON.stringify({ id: h.p.id, revision: 1 })),
		/actual user/
	);
	assert.equal(h.p.status, "monitoring");
});
