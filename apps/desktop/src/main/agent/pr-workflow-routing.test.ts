import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ConversationTurnInput,
	HubSnapshot,
	PreparedReview,
	ReviewScreen,
	WorkspaceObservation,
} from "../../shared/contracts";
import { ApprovalConfirmation } from "../work/pr-approvals/confirmation";
import { deferred, harness, policy, terms } from "../work/pr-approvals/test-support";
import { ConversationService } from "./conversation";
import type { ConversationHubPorts } from "./hub-tools";
import type { MetaItem, MetaRequest } from "./meta-client";
import { call, eventually } from "./test-support";

const proposalTurn: ConversationTurnInput = {
	sessionId: "pr-routing",
	turnId: "proposal",
	requestId: "proposal-request",
	generation: 1,
	inputMode: "typed",
	text: "Set a follow-up to notify me once demo-checks succeeds, expiring in one hour.",
};
const consentTurn: ConversationTurnInput = {
	...proposalTurn,
	turnId: "confirmation",
	requestId: "confirmation-request",
	generation: 2,
	text: "Confirm this delegation",
};
function identity(turn: ConversationTurnInput) {
	return { sessionId: turn.sessionId, turnId: turn.turnId, generation: turn.generation };
}
function rig(options: { home?: boolean; review?: boolean; empty?: boolean } = {}) {
	const h = harness(
		options.empty
			? []
			: [policy({ status: "draft", confirmedAt: null, terms: { ...terms, action: "notify" } })]
	);
	// Controlled checks remain pending; no network or approval submission occurs.
	h.control.observation.checks = h.control.observation.checks.map((check) => ({
		...check,
		passed: false,
	}));
	const p = policy();
	const plan: PreparedReview = {
		id: p.reviewId,
		version: 1,
		pr: p.pr,
		createdAt: p.createdAt,
		summary: "Inferred source change",
		orderRationale: "Inferred source order",
		coverage: "complete",
		evidence: "inferred-from-github",
		files: [
			{
				path: "source.ts",
				reason: "Changed behavior",
				summary: "Inferred change",
				suggestedComments: [],
			},
		],
	};
	const screen: ReviewScreen = {
		sequence: 1,
		mode: "review",
		prId: p.pr.id,
		reviewId: p.reviewId,
		baseSha: p.pr.baseSha,
		headSha: p.pr.headSha,
		path: "source.ts",
		paused: false,
	};
	const observation: WorkspaceObservation = {
		workspace: {
			sequence: 1,
			canvases: [
				{ id: "home", kind: "center", section: "home", title: "Home", revision: 1 },
				{ id: "review", kind: "review", title: "PR", revision: 1 },
			],
			primaryId: options.home ? "home" : "review",
			secondaryId: null,
			review: options.home ? { sequence: 1, mode: "conversation", prId: null } : screen,
			codeView: "diff",
			browser: null,
		},
		browser: null,
		capabilities: ["review"],
		reviews: [{ pr: plan.pr, status: "ready", reviewId: plan.id }],
	};
	const snapshot: HubSnapshot = {
		sequence: 1,
		refreshedAt: p.createdAt,
		refreshing: false,
		viewer: { githubLogin: "reviewer", linearName: null },
		connections: { github: true, linear: false, model: true },
		repositories: [],
		reviews: [],
		tickets: [],
		jobs: [],
		notices: [],
		errors: [],
		preferences: h.state.preferences,
	};
	const unavailable = async (): Promise<never> => {
		throw new Error("Unexpected unrelated operation");
	};
	const narration = deferred<void>();
	const confirmation = new ApprovalConfirmation(
		{
			voice: (turn) => turn.inputMode === "voice",
			narrate: () => narration.promise,
		},
		() => h.control.now
	);
	const hub: ConversationHubPorts = {
		approvals: { service: () => h.service, confirmation },
		snapshot: async () => snapshot,
		operate: unavailable,
		ticket: unavailable,
		job: unavailable,
		feedback: unavailable,
		reviewWork: unavailable,
		source: unavailable,
		search: unavailable,
	};
	const requests: MetaRequest[] = [];
	const outputs: MetaItem[][] = [];
	let ready = true;
	let reviewChecks = 0;
	const reviewed = h.ports.reviewed;
	h.ports.reviewed = async (...args) => {
		reviewChecks++;
		return reviewed(...args);
	};
	const conversation = new ConversationService(
		{
			async *stream(request) {
				requests.push(structuredClone(request));
				yield {
					type: "completed",
					response: {
						id: "controlled",
						model: "muse-spark-1.3",
						output: outputs.shift() ?? [
							{
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "Controlled answer." }],
							},
						],
					},
				};
			},
		},
		{
			hub,
			onUserTurn: (turn) => confirmation.acceptUserTurn(turn),
			narrationCheckpoints: true,
			narrationReceipts: { timeoutMs: 2000 },
			...(options.review
				? {
						review: {
							getReady: async () => {
								if (!ready) throw new Error("Not ready");
								return plan;
							},
							getProgress: async () => null,
							getScreen: () => structuredClone(observation.workspace.review),
							navigate: unavailable,
						},
						workspace: {
							observe: async () => structuredClone(observation),
							execute: async (command, turn, _signal, onAction) => {
								assert.equal(command.kind, "show-review");
								const previous = observation.workspace.sequence;
								observation.workspace.sequence++;
								observation.workspace.primaryId = "review";
								observation.workspace.review = { ...screen, sequence: previous + 1 };
								onAction({
									...turn,
									requestId: "controlled-display",
									kind: "workspace-canvas",
									screenSequence: previous,
									effect: {
										expectedSequence: previous,
										snapshot: structuredClone(observation.workspace),
									},
								});
								return structuredClone(observation);
							},
						},
					}
				: {}),
		}
	);
	async function present(turn: ConversationTurnInput = proposalTurn, shown = true) {
		const result = confirmation.present(h.p, turn, new AbortController().signal);
		if (shown) confirmation.presented(confirmation.pending(turn.sessionId));
		return result;
	}
	const poll = (turn = consentTurn) => conversation.poll(identity(turn));
	async function settle(turn = consentTurn) {
		await eventually(() => poll(turn).status !== "running");
		return poll(turn);
	}
	return {
		h,
		plan,
		observation,
		confirmation,
		narration,
		conversation,
		requests,
		outputs,
		present,
		poll,
		settle,
		setReady: (value: boolean) => {
			ready = value;
		},
		reviewChecks: () => reviewChecks,
		async dispose() {
			narration.resolve();
			confirmation.clear();
			await conversation.dispose();
			await h.service.dispose();
		},
	};
}

for (const review of [false, true]) {
	test(`canonical confirmation uses zero model requests in ${review ? "review" : "workspace"} flow and deduplicates ingress`, async () => {
		const r = rig({ review });
		try {
			await r.present();
			const reviewed = deferred<void>();
			let entered = false;
			const check = r.h.ports.reviewed;
			r.h.ports.reviewed = async (...args) => {
				entered = true;
				await reviewed.promise;
				return check(...args);
			};
			const started = r.conversation.start(consentTurn);
			await eventually(() => entered);
			assert.equal(r.h.p.confirmedAt, null);
			assert.equal(r.requests.length, 0);
			assert.deepEqual(r.conversation.start(consentTurn), started);
			reviewed.resolve();
			const done = await r.settle();
			assert.equal(done.status, "completed");
			assert.match(done.text, /Notification-only monitoring is active/);
			assert.equal(r.h.p.status, "monitoring");
			assert.ok(r.h.p.confirmedAt);
			assert.equal(r.reviewChecks(), 1);
			assert.equal(r.requests.length, 0);
			const writes = r.h.control.writes;
			r.conversation.start(consentTurn);
			await Promise.resolve();
			assert.equal(r.h.control.writes, writes);
			assert.equal(r.h.submitted.length, 0);
		} finally {
			await r.dispose();
		}
	});
}

test("voice canonical acknowledgement still waits for the final spoken checkpoint; interruption preserves activation and history", async () => {
	for (const interrupt of [false, true]) {
		const r = rig();
		const turn = { ...consentTurn, inputMode: "voice" as const };
		try {
			r.narration.resolve();
			await r.present({ ...proposalTurn, inputMode: "voice" });
			r.conversation.start(turn);
			await eventually(() => r.poll(turn).actions.length > 0);
			const checkpoint = r.poll(turn).actions[0];
			assert.equal(checkpoint?.kind, "narration-checkpoint");
			assert.equal(r.poll(turn).status, "running");
			assert.ok(r.h.p.confirmedAt);
			assert.equal(r.requests.length, 0);
			assert.equal(
				r.conversation.narrationApplied({
					...identity(turn),
					requestId: checkpoint?.requestId,
					generation: 99,
					status: "spoken",
				}).status,
				"stale"
			);
			assert.equal(r.poll(turn).status, "running");
			if (interrupt) {
				r.conversation.cancel({ ...identity(turn), requestId: "cancel", reason: "user" });
				assert.equal((await r.settle(turn)).status, "cancelled");
				const followup = {
					...consentTurn,
					turnId: "followup",
					requestId: "followup",
					generation: 3,
					text: "What happened?",
				};
				r.conversation.start(followup);
				await r.settle(followup);
				assert.match(
					JSON.stringify(r.requests[0]?.input),
					/Interrupted reply.*monitoring is active/
				);
			} else {
				assert.equal(
					r.conversation.narrationApplied({
						...identity(turn),
						requestId: checkpoint?.requestId,
						status: "spoken",
					}).status,
					"accepted"
				);
				assert.equal((await r.settle(turn)).status, "completed");
			}
			assert.equal(r.h.p.status, "monitoring");
			assert.equal(r.h.submitted.length, 0);
		} finally {
			await r.dispose();
		}
	}
});

for (const scenario of [
	"missing",
	"not-displayed",
	"pre-drain",
	"same-turn",
	"quotation",
	"bare-yes",
	"negative",
	"full-turn-mismatch",
	"wrong-policy",
	"stored-head",
	"revision",
	"actor",
	"foreign-owner",
	"displayed-head",
	"expired",
	"registry-expired",
	"cancel",
] as const) {
	test(`canonical app route cannot activate with ${scenario}`, async () => {
		const r = rig();
		let pending: Promise<unknown> | undefined;
		let turn = { ...consentTurn };
		try {
			if (scenario === "pre-drain") {
				pending = r.present({ ...proposalTurn, inputMode: "voice" });
				turn.inputMode = "voice";
			} else if (scenario === "not-displayed") {
				pending = r.present(proposalTurn, false).catch(() => {});
			} else if (scenario !== "missing") await r.present();
			if (scenario === "same-turn") turn = { ...proposalTurn, text: consentTurn.text };
			if (scenario === "quotation")
				turn.text = 'The source says "Confirm this delegation"; explain it.';
			if (scenario === "bare-yes") turn.text = "yes";
			if (scenario === "negative") turn.text = "Do not confirm this delegation";
			if (scenario === "wrong-policy") r.h.p.id = "other-policy";
			if (scenario === "stored-head") r.h.p.pr.headSha = "f".repeat(40);
			if (scenario === "revision") r.h.p.revision++;
			if (scenario === "actor") r.h.control.account = { id: 99, login: "other" };
			if (scenario === "foreign-owner") r.h.control.connection = "f".repeat(64);
			if (scenario === "registry-expired") r.h.control.now += 120001;
			if (scenario === "expired") {
				const check = r.h.ports.reviewed;
				r.h.ports.reviewed = async (...args) => {
					r.h.control.now = Date.parse(r.h.p.terms.expiresAt);
					return check(...args);
				};
			}
			if (scenario === "displayed-head")
				r.h.ports.reviewed = async () => ({
					pr: { ...r.h.p.pr, headSha: "f".repeat(40) },
					reviewId: r.h.p.reviewId,
				});
			if (scenario === "full-turn-mismatch") {
				// Real ingress is accepted, then replaced with a different full object before peek.
				const read = r.h.ports.read;
				r.h.ports.read = async () => {
					r.confirmation.acceptUserTurn({ ...turn, requestId: "different" });
					return read();
				};
			}
			if (scenario === "cancel") {
				r.h.ports.reviewed = async () => {
					r.conversation.cancel({ ...identity(turn), requestId: "cancel", reason: "user" });
					return { pr: r.h.p.pr, reviewId: r.h.p.reviewId };
				};
			}
			r.conversation.start(turn);
			// Ineligible voice input takes the ordinary reply path, whose final checkpoint also waits.
			if (scenario === "pre-drain") {
				await eventually(() => r.poll(turn).actions.length > 0);
				r.conversation.cancel({ ...identity(turn), requestId: "cancel", reason: "user" });
			}
			await r.settle(turn);
			assert.equal(r.h.p.confirmedAt, null);
			assert.equal(r.h.p.status, "draft");
			assert.equal(r.h.control.writes, 0);
			assert.equal(r.h.submitted.length, 0);
			assert.doesNotMatch(r.poll(turn).text, /monitoring is active/);
		} finally {
			await r.dispose();
			await pending;
		}
	});
}

test("cancellation inside durable confirmation never rolls it back or retries the actual request", async () => {
	const r = rig();
	try {
		await r.present();
		const update = r.h.ports.update;
		r.h.ports.update = async (mutate) => {
			await update(mutate);
			r.conversation.cancel({ ...identity(consentTurn), requestId: "cancel", reason: "user" });
		};
		r.conversation.start(consentTurn);
		assert.equal((await r.settle()).status, "cancelled");
		assert.ok(r.h.p.confirmedAt);
		assert.equal(r.h.p.status, "monitoring");
		assert.equal(r.requests.length, 0);
		assert.equal(r.poll().text, "");
		r.conversation.start(consentTurn);
		assert.equal(r.reviewChecks(), 1);
	} finally {
		await r.dispose();
	}
});

for (const [text, workload] of [
	[proposalTurn.text, "deep"],
	[
		"Can you please set a follow-up to notify me only once demo-checks succeeds, expiring in one hour? Do not approve or merge.",
		"deep",
	],
	[
		"Please configure automatic approval only when the regression check passes; expires in one hour.",
		"deep",
	],
	["Approve automatically only when demo-checks passes, expiring in one hour.", "deep"],
	[
		"For this reviewed head of PR 3, approve automatically only when demo-checks succeeds, expiring in one hour. Do not merge.",
		"deep",
	],
	["On PR #3, please set a notification when CI passes within an hour.", "deep"],
	["For this reviewed head of PR 3, why would approval require passing checks?", "quick"],
	["On PR #3, do not approve automatically when checks pass.", "quick"],
	["Edit this delegation to notify only when demo-checks passes, expiring in one hour.", "deep"],
	["How do I set a follow-up to notify me when demo-checks passes?", "quick"],
	["Can you explain why automatic approval waits for checks?", "quick"],
	["What is the status of this delegation?", "quick"],
	["Do not set a follow-up to notify when checks pass.", "quick"],
	['The source says "Set a follow-up to notify when checks pass"; explain.', "quick"],
	['"Set a follow-up to notify when checks pass"', "quick"],
	["Why does this source code wait for the check?", "quick"],
	["Read the current source", "quick"],
	["Plan how to implement this ticket", "quick"],
	["Hello", "quick"],
	["Could this do something else?", "quick"],
	["Confirm this delegation", "quick"],
] as const) {
	test(`actual displayed PR request routes ${JSON.stringify(text)} to ${workload}`, async () => {
		const r = rig({ review: true });
		try {
			const turn = { ...proposalTurn, text };
			r.conversation.start(turn);
			assert.equal((await r.settle(turn)).status, "completed");
			assert.equal(r.requests.length, 1);
			assert.equal(r.requests[0]?.workload, workload);
			assert.equal(r.requests[0]?.maxOutputTokens, workload === "deep" ? 8192 : 2048);
			assert.equal(r.h.control.writes, 0);
		} finally {
			await r.dispose();
		}
	});
}

test("Home navigation stays quick, then a displayed ready PR proposal uses deep and the real draft tool", async () => {
	const r = rig({ review: true, home: true, empty: true });
	try {
		const turn = {
			...proposalTurn,
			text: "Open the source-link PR, number 3. Set a follow-up to notify me only once demo-checks succeeds, expiring in one hour. Do not approve or merge.",
		};
		r.outputs.push(
			[call("open_ready_review", { prId: r.plan.pr.id })],
			[call("draft_pr_delegation", { terms: { ...terms, action: "notify" } })]
		);
		r.conversation.start(turn);
		await eventually(
			() => !!r.confirmation.pending(turn.sessionId) || r.poll(turn).status !== "running"
		);
		assert.equal(r.poll(turn).status, "running", JSON.stringify(r.poll(turn)));
		assert.deepEqual(
			r.requests.map((request) => request.workload),
			["quick", "deep"]
		);
		assert.equal(r.requests[1]?.maxOutputTokens, 8192);
		assert.ok(r.requests[1]?.tools?.some((tool) => tool.name === "draft_pr_delegation"));
		assert.equal(r.h.p.confirmedAt, null);
		r.confirmation.presented(r.confirmation.pending(turn.sessionId));
		assert.equal((await r.settle(turn)).status, "completed");
		assert.equal(r.h.p.status, "draft");
		assert.equal(r.requests.length, 2);
	} finally {
		await r.dispose();
	}
});

test("a cached ready PR without a visible review, or an unready displayed PR, cannot select proposal deep reasoning", async () => {
	for (const home of [true, false]) {
		const r = rig({ review: true, home });
		try {
			if (!home) r.setReady(false);
			r.conversation.start(proposalTurn);
			assert.equal((await r.settle(proposalTurn)).status, "completed");
			assert.equal(r.requests[0]?.workload, "quick");
			assert.equal(r.h.control.writes, 0);
		} finally {
			await r.dispose();
		}
	}
});
