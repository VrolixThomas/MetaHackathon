import assert from "node:assert/strict";
import { it } from "node:test";
import type { ConversationTurnInput, PRFixDetail } from "../../shared/contracts";
import { ApprovalConfirmation } from "../work/pr-approvals/confirmation";
import {
	at,
	deferred,
	harness,
	head,
	later,
	policy,
	pr,
	terms,
} from "../work/pr-approvals/test-support";
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
		tools.execute("edit_pr_delegation", JSON.stringify({ policyId: h.p.id, revision: 2, terms })),
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
			JSON.stringify({
				terms: { ...terms, conditions: [{ kind: "check", name: secret, appId: secret }] },
			}),
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
		[
			JSON.stringify({
				terms: { ...terms, conditions: [...terms.conditions, ...terms.conditions] },
			}),
			/terms: custom/,
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

it("empty delegation inspection reports available operations without activation or fabricated service availability", async () => {
	const h = harness([]);
	const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	const tools = new ApprovalTools(
		{ service: () => h.service, confirmation },
		turn,
		new AbortController().signal
	);
	try {
		const result = (await tools.execute("inspect_pr_delegations", "{}")) as {
			status: string;
			policies: unknown[];
			availableTools: string[];
			authority: string;
		};
		assert.equal(result.status, "available");
		assert.deepEqual(result.policies, []);
		assert.deepEqual(
			result.availableTools,
			tools.tools.map((tool) => tool.name)
		);
		assert.match(result.authority, /Separate real user confirmation/);
		assert.deepEqual(await h.service.list(), []); // Public service/RPC shape remains unchanged.
		assert.equal(h.control.writes, 0);
		assert.equal(h.submitted.length, 0);
		const unavailable = new ApprovalTools(
			{
				service: () => {
					throw new Error("Service absent");
				},
				confirmation,
			},
			turn,
			new AbortController().signal
		);
		await assert.rejects(unavailable.execute("inspect_pr_delegations", "{}"), /Service absent/);
	} finally {
		await h.service.dispose();
	}
});

it("new follow-up creation normalizes an unspecified check app without accepting invented edit identity", async () => {
	const h = harness([]);
	const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	const tools = new ApprovalTools(
		{ service: () => h.service, confirmation },
		turn,
		new AbortController().signal
	);
	await assert.rejects(
		tools.execute(
			"draft_pr_delegation",
			JSON.stringify({ id: "invented-policy", revision: 1, terms })
		)
	);
	assert.equal(h.state.approvalPolicies?.length ?? 0, 0);
	const outcome = tools.execute(
		"draft_pr_delegation",
		JSON.stringify({ terms: { ...terms, conditions: [{ kind: "check", name: "ci" }] } })
	);
	await eventually(() => !!confirmation.pending(turn.sessionId));
	assert.deepEqual(h.p.terms.conditions, [{ kind: "check", name: "ci", appId: null }]);
	assert.equal(h.p.status, "draft");
	assert.equal(h.submitted.length, 0);
	const pending = confirmation.pending(turn.sessionId);
	assert.ok(pending);
	confirmation.presented(pending);
	await outcome;
	await h.service.dispose();
});
it("editing requires an observed policy identity and produces a new unconfirmed revision", async () => {
	const h = harness([policy({ status: "draft", confirmedAt: null })]);
	const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	const tools = new ApprovalTools(
		{ service: () => h.service, confirmation },
		turn,
		new AbortController().signal
	);
	const edit = { policyId: h.p.id, revision: h.p.revision, terms: { ...terms, action: "notify" } };
	await assert.rejects(tools.execute("edit_pr_delegation", JSON.stringify(edit)), /Inspect/);
	assert.equal(h.p.revision, 1);
	await tools.execute("inspect_pr_delegations", "{}");
	const outcome = tools.execute("edit_pr_delegation", JSON.stringify(edit));
	await eventually(() => !!confirmation.pending(turn.sessionId));
	assert.equal(h.p.revision, 2);
	assert.equal(h.p.status, "draft");
	assert.equal(h.p.confirmedAt, null);
	assert.equal(h.submitted.length, 0);
	const pending = confirmation.pending(turn.sessionId);
	assert.ok(pending);
	confirmation.presented(pending);
	await outcome;
	await h.service.dispose();
});

it("fresh canonical context enables exact confirmation without inspect and never activates by reading", async () => {
	const h = harness([
		policy({ status: "draft", confirmedAt: null, terms: { ...terms, action: "notify" } }),
	]);
	const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	const user = {
		...turn,
		text: "Confirm this delegation",
		turnId: "confirm",
		requestId: "confirm",
		generation: 2,
	};
	const tools = new ApprovalTools(
		{ service: () => h.service, confirmation },
		user,
		new AbortController().signal
	);
	try {
		assert.equal(await tools.confirmationContext(), undefined);
		const displayed = confirmation.present(h.p, turn, new AbortController().signal);
		confirmation.presented(confirmation.pending("s"));
		await displayed;
		const before = h.control.writes;
		assert.equal((await tools.confirmationContext())?.currentTurnAccepted, false);
		await assert.rejects(
			tools.execute("confirm_pr_delegation", JSON.stringify({ id: h.p.id, revision: 1 })),
			/Explicit confirmation/
		);
		confirmation.acceptUserTurn(user);
		for (let i = 0; i < 2; i++) {
			const context = await tools.confirmationContext();
			assert.equal(context?.id, h.p.id);
			assert.equal(context?.digest, h.p.digest);
			assert.equal(context?.currentTurnAccepted, true);
			assert.equal(context?.spoken, false);
		}
		assert.equal(h.control.writes, before);
		assert.equal(h.p.status, "draft");
		assert.equal(Boolean(tools.handoff), false);
		await tools.execute("confirm_pr_delegation", JSON.stringify({ id: h.p.id, revision: 1 }));
		assert.ok(h.p.confirmedAt);
		assert.match(tools.handoff?.acknowledgement ?? "", /Notification-only monitoring is active/);
		assert.equal(h.submitted.length, 0);
	} finally {
		await h.service.dispose();
	}
});

for (const changed of [
	"foreign-owner",
	"stored-head",
	"revision",
	"registry",
	"account",
	"displayed-head",
	"cancel",
] as const) {
	it(`canonical context cannot bypass ${changed} at confirmation`, async () => {
		const h = harness([policy({ status: "draft", confirmedAt: null })]);
		const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
		const user = {
			...turn,
			text: "Confirm this delegation",
			turnId: "confirm",
			requestId: "confirm",
			generation: 2,
		};
		const controller = new AbortController();
		const tools = new ApprovalTools(
			{ service: () => h.service, confirmation },
			user,
			controller.signal
		);
		try {
			const displayed = confirmation.present(h.p, turn, controller.signal);
			confirmation.presented(confirmation.pending("s"));
			await displayed;
			confirmation.acceptUserTurn(user);
			assert.equal((await tools.confirmationContext())?.currentTurnAccepted, true);
			if (changed === "foreign-owner") h.control.connection = "f".repeat(64);
			if (changed === "stored-head") h.p.pr.headSha = "f".repeat(40);
			if (changed === "revision") h.p.revision++;
			if (changed === "registry") confirmation.clear();
			if (changed === "account") h.control.account = { id: 99, login: "other" };
			if (changed === "displayed-head")
				h.ports.reviewed = async () => ({
					pr: { ...h.p.pr, headSha: "f".repeat(40) },
					reviewId: h.p.reviewId,
				});
			if (changed === "cancel") controller.abort();
			if (["foreign-owner", "stored-head", "revision", "registry"].includes(changed))
				assert.equal(await tools.confirmationContext(), undefined);
			await assert.rejects(
				tools.execute("confirm_pr_delegation", JSON.stringify({ id: h.p.id, revision: 1 }))
			);
			assert.equal(h.p.status, "draft");
			assert.equal(h.p.confirmedAt, null);
			assert.equal(tools.handoff, undefined);
			assert.equal(h.submitted.length, 0);
		} finally {
			await h.service.dispose();
		}
	});
}

function candidate(): PRFixDetail {
	const time = new Date(at).toISOString();
	const feedback = {
		id: "feedback",
		prId: pr.id,
		author: "reviewer",
		body: "Fix this",
		url: pr.url,
		createdAt: time,
		updatedAt: time,
		kind: "inline" as const,
		state: null,
		path: "a.ts",
		line: 1,
		commitSha: head,
		suggestion: null,
	};
	const fix = {
		id: "fix",
		jobId: "job",
		pr,
		feedback,
		phase: "ready" as const,
		summary: "",
		question: null,
		baseSha: head,
		headSha: later,
		checks: [],
		changedFiles: ["a.ts"],
		createdAt: time,
		updatedAt: time,
		reviewedAt: time,
		error: null,
		publication: "not-published" as const,
	};
	return {
		fix,
		review: {
			job: {
				id: "job",
				ticket: null,
				feedback: structuredClone(feedback),
				repositoryId: "repo",
				repository: pr.repository,
				state: "ready",
				branch: "private/fix",
				worktreePath: null,
				baseSha: head,
				headSha: later,
				brief: "Fix",
				summary: "",
				createdAt: time,
				updatedAt: time,
				decisions: [],
				checks: [],
				changedFiles: ["a.ts"],
				pullRequest: null,
				error: null,
			},
			files: [
				{
					path: "a.ts",
					status: "modified",
					patch: null,
					base: { path: "a.ts", commitSha: head, status: "available", content: "before\n" },
					head: { path: "a.ts", commitSha: later, status: "available", content: "\uFEFFafter\r\n" },
				},
			],
		},
	};
}

it("reviewed-fix tool reads fresh main bytes, retains presentation/consent gates and rejects model source", async () => {
	const h = harness([]);
	const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	let reads = 0;
	const tools = new ApprovalTools(
		{
			service: () => h.service,
			confirmation,
			reviewedFix: {
				detail: async () => {
					reads++;
					return candidate();
				},
				reviewed: async () => pr,
			},
		},
		turn,
		new AbortController().signal
	);
	const args = {
		candidateId: "fix",
		action: terms.action,
		expiresAt: terms.expiresAt,
		checks: terms.conditions,
	};
	await assert.rejects(
		tools.execute(
			"draft_pr_delegation_from_fix",
			JSON.stringify({ ...args, expectedContent: "invented" })
		)
	);
	assert.equal(reads, 0);
	const pending = tools.execute("draft_pr_delegation_from_fix", JSON.stringify(args));
	await eventually(() => !!confirmation.pending("s"));
	assert.equal(reads, 2);
	assert.equal(h.p.status, "draft");
	assert.equal(h.p.confirmedAt, null);
	assert.equal(h.p.terms.conditions[0]?.kind, "source");
	const presentation = confirmation.pending("s");
	assert.ok(presentation);
	confirmation.presented(presentation);
	await pending;
	assert.equal(h.submitted.length, 0);
	await h.service.dispose();
});
it("reviewed-fix tool is unavailable without root port and blocks wrong displayed PR before drafting", async () => {
	const h = harness([]);
	const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	const plain = new ApprovalTools(
		{ service: () => h.service, confirmation },
		turn,
		new AbortController().signal
	);
	assert.equal(plain.has("draft_pr_delegation_from_fix"), false);
	assert.equal(
		plain.tools.some((t) => t.name === "draft_pr_delegation_from_fix"),
		false
	);
	const tools = new ApprovalTools(
		{
			service: () => h.service,
			confirmation,
			reviewedFix: {
				detail: async () => candidate(),
				reviewed: async () => ({ ...pr, headSha: later }),
			},
		},
		turn,
		new AbortController().signal
	);
	await assert.rejects(
		tools.execute(
			"draft_pr_delegation_from_fix",
			JSON.stringify({
				candidateId: "fix",
				action: terms.action,
				expiresAt: terms.expiresAt,
				checks: [],
			})
		),
		/complete reviewed candidate/
	);
	assert.equal((await h.service.list()).length, 0);
});
it("candidate refresh failure prevents proposal presentation", async () => {
	const h = harness([]);
	const confirmation = new ApprovalConfirmation({ voice: () => false, narrate: async () => {} });
	let reads = 0;
	const tools = new ApprovalTools(
		{
			service: () => h.service,
			confirmation,
			reviewedFix: {
				detail: async () => {
					if (++reads > 1) throw new Error("feedback changed");
					return candidate();
				},
				reviewed: async () => pr,
			},
		},
		turn,
		new AbortController().signal
	);
	await assert.rejects(
		tools.execute(
			"draft_pr_delegation_from_fix",
			JSON.stringify({
				candidateId: "fix",
				action: terms.action,
				expiresAt: terms.expiresAt,
				checks: [],
			})
		),
		/feedback changed/
	);
	assert.equal(confirmation.pending("s"), null);
	assert.equal(h.p.confirmedAt, null);
	assert.equal(h.submitted.length, 0);
});
