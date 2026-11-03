import assert from "node:assert/strict";
import { it } from "node:test";
import type { ConversationTurnInput } from "../../shared/contracts";
import { ApprovalConfirmation } from "../work/pr-approvals/confirmation";
import { deferred, harness, policy, terms } from "../work/pr-approvals/test-support";
import { ApprovalTools } from "./approval-tools";
import { ConversationService } from "./conversation";
import { eventually } from "./test-support";
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

// Exercise the same full ingress object passed by production ApprovalConfirmation.
it("full voice ingress reaches a strict proposal checkpoint and requires drained distinct-turn consent", async () => {
	const h = harness([]);
	const release = deferred<void>();
	const voice: ConversationTurnInput = { ...turn, inputMode: "voice", prId: "owner/repo#1" };
	const identity = {
		sessionId: voice.sessionId,
		turnId: voice.turnId,
		generation: voice.generation,
	};
	const conversation = new ConversationService(
		{
			async *stream() {
				await release.promise;
				yield { type: "completed", response: { id: "held", model: "muse-spark-1.3", output: [] } };
			},
		},
		{
			getContext: async () => ({
				pr: h.p?.pr ?? policy().pr,
				description: "controlled",
				files: [],
				truncated: false,
			}),
		}
	);
	const confirmation = new ApprovalConfirmation({
		voice: (input) => conversation.isVoiceTurn(input),
		narrate: (input, id, text, signal) => {
			assert.deepEqual(input, voice);
			return conversation.narrateProposal(input, id, text, signal);
		},
	});
	const controller = new AbortController();
	try {
		conversation.start(voice);
		const tools = new ApprovalTools(
			{ service: () => h.service, confirmation },
			voice,
			controller.signal
		);
		let settled = false;
		const drafting = tools.execute(
			"draft_pr_delegation",
			JSON.stringify({ terms: { ...terms, action: "notify" } })
		);
		const outcome = drafting.then(
			() => {
				settled = true;
				return null;
			},
			(error: unknown) => {
				settled = true;
				return error;
			}
		);
		await eventually(() => !!confirmation.pending(voice.sessionId));
		const pending = confirmation.pending(voice.sessionId);
		assert.ok(pending);
		confirmation.presented(pending);
		await eventually(() => settled || conversation.poll(identity).actions.length > 0);
		if (settled) assert.equal(await outcome, null);
		const action = conversation.poll(identity).actions[0];
		assert.ok(action);
		assert.equal(action.kind, "narration-checkpoint");
		assert.equal("text" in action, false);
		assert.equal("inputMode" in action, false);
		assert.equal("prId" in action, false);
		assert.notEqual(action.requestId, voice.requestId);
		assert.equal(settled, false);
		const consent: ConversationTurnInput = {
			...voice,
			text: "confirm this delegation",
			turnId: "later-user",
			generation: 2,
			requestId: "later-request",
		};
		confirmation.acceptUserTurn(consent);
		assert.throws(() => confirmation.take(consent, h.p), /Explicit confirmation/);
		assert.equal(
			conversation.narrationApplied({
				...identity,
				generation: 99,
				requestId: action.requestId,
				status: "spoken",
			}).status,
			"stale"
		);
		assert.equal(settled, false);
		assert.equal(
			conversation.narrationApplied({ ...identity, requestId: action.requestId, status: "spoken" })
				.status,
			"accepted"
		);
		assert.equal(await outcome, null);
		confirmation.acceptUserTurn({ ...voice, text: "confirm this delegation" });
		assert.throws(() => confirmation.take(voice, h.p), /Explicit confirmation/);
		conversation.start(consent);
		confirmation.acceptUserTurn(consent);
		const next = new ApprovalTools(
			{ service: () => h.service, confirmation },
			consent,
			controller.signal
		);
		await next.execute("inspect_pr_delegations", "{}");
		await next.execute(
			"confirm_pr_delegation",
			JSON.stringify({ id: h.p.id, revision: h.p.revision })
		);
		assert.ok(h.p.confirmedAt);
		assert.equal(h.p.terms.action, "notify");
		assert.equal(h.submitted.length, 0);
		await assert.rejects(
			conversation.narrateProposal(voice, "stale-proposal", "Stale", controller.signal),
			/stale/
		);
	} finally {
		controller.abort();
		confirmation.clear();
		release.resolve();
		await conversation.dispose();
		await h.service.dispose();
	}
});

it("approval input errors expose bounded schema paths before service access, never supplied values", async () => {
	const { WorkspaceArgumentError } = await import("./workspace-tools");
	const h = harness([]);
	let serviceReads = 0;
	const tools = new ApprovalTools(
		{
			service: () => {
				serviceReads++;
				return h.service;
			},
			confirmation: new ApprovalConfirmation({ voice: () => false, narrate: async () => {} }),
		},
		turn,
		new AbortController().signal
	);
	const secret = "UNTRUSTED_PRIVATE_VALUE";
	const cases: [string, RegExp][] = [
		[
			JSON.stringify({ terms: { ...terms, conditions: [{ kind: "check", name: secret }] } }),
			/terms\.conditions\.0\.appId: invalid_type; expected number/,
		],
		[
			JSON.stringify({ terms: { ...terms, expiresAt: secret } }),
			/terms\.expiresAt: invalid_format/,
		],
		[
			JSON.stringify({ terms: { ...terms, action: secret } }),
			/terms\.action: invalid_value; expected \["approve","notify"\]/,
		],
		[JSON.stringify({ terms, [secret]: secret }), /arguments: unrecognized_keys/],
		[secret, /arguments: invalid_json/],
	];
	try {
		for (const [raw, expected] of cases) {
			await assert.rejects(tools.execute("draft_pr_delegation", raw), (error) => {
				assert(error instanceof WorkspaceArgumentError);
				assert.match(error.message, expected);
				assert(!error.message.includes(secret));
				return true;
			});
		}
		assert.equal(serviceReads, 0);
		assert.equal(h.control.reads, 0);
		assert.equal(h.control.writes, 0);
	} finally {
		await h.service.dispose();
	}
});

it("provider or post-validation errors never become repairable input failures", async () => {
	const { WorkspaceArgumentError } = await import("./workspace-tools");
	const { z } = await import("zod");
	const h = harness([]);
	h.provider.account = async () => z.never().parse("provider-controlled failure");
	const tools = new ApprovalTools(
		{
			service: () => h.service,
			confirmation: new ApprovalConfirmation({ voice: () => false, narrate: async () => {} }),
		},
		turn,
		new AbortController().signal
	);
	try {
		await assert.rejects(
			tools.execute("draft_pr_delegation", JSON.stringify({ terms })),
			(error) => {
				assert(error instanceof z.ZodError);
				assert(!(error instanceof WorkspaceArgumentError));
				return true;
			}
		);
		assert.equal(h.control.writes, 0);
	} finally {
		await h.service.dispose();
	}
});
