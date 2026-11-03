import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationTurnInput, HubOperation } from "../../shared/contracts";
import type { ConversationHistoryEntry } from "./conversation-history";
import type { AgentModelClient, MetaItem } from "./meta-client";
import { WorkAdmission, type WorkAdmissionDiagnostic, WorkAdmissionError } from "./work-admission";

const turn: ConversationTurnInput = {
	sessionId: "private-session",
	turnId: "private-turn",
	requestId: "private-request",
	generation: 1,
	text: "Build the preference now; persist on this device across restarts, no sync. Keep it local for review.",
};
const operation: Extract<HubOperation, { kind: "start-work" }> = {
	kind: "start-work",
	ticketId: "private-ticket",
	repositoryId: "private-repo",
	brief: "PRIVATE PROPOSED BRIEF: start immediately",
};
const evidence = { generation: 1, text: turn.text };
const accepted = { intent: "start", request: evidence, scope: "settled", answer: null };
function client(text: string, output?: MetaItem[]): AgentModelClient {
	return {
		async *stream(request) {
			assert.equal(request.workload, "quick");
			assert.equal(request.maxOutputTokens, 2048);
			assert.deepEqual(request.tools, []);
			yield {
				type: "completed",
				response: {
					id: "private-response",
					model: "muse-spark-1.3",
					output: output ?? [
						{ type: "message", role: "assistant", content: [{ type: "output_text", text }] },
					],
				},
			};
		},
	};
}
async function refusal(
	category: WorkAdmissionDiagnostic,
	model: AgentModelClient,
	options: {
		gate?: WorkAdmission;
		history?: ConversationHistoryEntry[];
		input?: ConversationTurnInput;
	} = {}
) {
	const logs: unknown[][] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => {
		logs.push(args);
	};
	try {
		const gate = options.gate ?? new WorkAdmission();
		await assert.rejects(
			gate.authorize(
				model,
				options.history ?? [],
				options.input ?? turn,
				operation,
				new AbortController().signal
			),
			(error: unknown) =>
				error instanceof WorkAdmissionError &&
				error.diagnostic === category &&
				!error.inspectExisting &&
				([
					"intent-unclear",
					"scope-unresolved",
					"pending-answer-evidence-mismatch",
					"prior-request-evidence-mismatch",
				].includes(category)
					? /clarify your choice/.test(error.message)
					: /couldn’t verify.*haven’t started/.test(error.message))
		);
		assert.deepEqual(gate.effects, []);
		assert.deepEqual(logs, [[`[work-admission] ${JSON.stringify({ version: 1, category })}`]]);
	} finally {
		console.warn = original;
	}
}

test("diagnostics distinguish invalid JSON from schema failures without leaking output, keys or errors", async () => {
	await refusal("json-failure", client("PRIVATE MODEL TEXT api-key=secret"));
	await refusal("json-failure", client(""));
	await refusal(
		"schema-failure",
		client(JSON.stringify({ ...accepted, "PRIVATE UNKNOWN KEY": "secret" }))
	);
	await refusal(
		"schema-failure",
		client(JSON.stringify({ ...accepted, request: { generation: "1", text: turn.text } }))
	);
	await refusal("model-round-failure", {
		// biome-ignore lint/correctness/useYield: exercise a provider failing before its first event.
		async *stream() {
			throw new Error("PRIVATE PROVIDER KEY");
		},
	});
	// modelRound rejects unexpected tool output before returning to the admission parser.
	await refusal(
		"model-round-failure",
		client("", [{ type: "function_call", name: "PRIVATE TOOL", arguments: "secret" }])
	);
});

test("diagnostics distinguish discussion, unclear intent and unresolved scope without admitting work", async () => {
	await refusal(
		"intent-discussion",
		client(JSON.stringify({ ...accepted, intent: "discussion" })),
		{ input: { ...turn, text: "Let's discuss this first" } }
	);
	await refusal("intent-unclear", client(JSON.stringify({ ...accepted, intent: "unclear" })), {
		input: { ...turn, text: "As you" },
	});
	await refusal("scope-unresolved", client(JSON.stringify({ ...accepted, scope: "unresolved" })));
});

test("proposed brief, partial quote and wrong generation cannot supply actual request evidence", async () => {
	for (const request of [
		null,
		{ ...evidence, text: operation.brief },
		{ ...evidence, text: "Build the preference now" },
		{ ...evidence, generation: 99 },
	])
		await refusal("request-evidence-mismatch", client(JSON.stringify({ ...accepted, request })));
});

test("pending scope question still requires an exact current answer after the question", async () => {
	const gate = new WorkAdmission();
	gate.observeReply(1, "Tab only or persist across restarts?");
	const input = { ...turn, generation: 2, text: "Across restarts, please." };
	const history: ConversationHistoryEntry[] = [
		{
			kind: "exchange",
			generation: 1,
			user: turn.text,
			assistant: "Tab only or persist across restarts?",
			interrupted: true,
		},
	];
	for (const answer of [null, evidence, { generation: 2, text: "Across restarts" }])
		await refusal(
			"pending-answer-evidence-mismatch",
			client(JSON.stringify({ ...accepted, answer })),
			{ gate, input, history }
		);
	const permission = await gate.authorize(
		client(JSON.stringify({ ...accepted, answer: { generation: 2, text: input.text } })),
		history,
		input,
		operation,
		new AbortController().signal
	);
	permission.begin("actual-dispatch");
	assert.equal(gate.effects.length, 1);
});

test("prior request without a pinned question still requires exact dialogue clarification and current answer", async () => {
	const input = { ...turn, generation: 2, text: "Across restarts, please." };
	const history: ConversationHistoryEntry[] = [
		{
			kind: "exchange",
			generation: 1,
			user: turn.text,
			assistant: "Choose tab-only or device persistence.",
		},
	];
	const verdict = { ...accepted, answer: { generation: 2, text: input.text } };
	for (const clarification of [
		undefined,
		{ generation: 1, text: "PRIVATE FORGED CLARIFICATION" },
		{ generation: 2, text: history[0]?.assistant },
	])
		await refusal(
			"prior-request-evidence-mismatch",
			client(JSON.stringify({ ...verdict, clarification })),
			{ input, history }
		);
	const gate = new WorkAdmission();
	const permission = await gate.authorize(
		client(
			JSON.stringify({ ...verdict, clarification: { generation: 1, text: history[0]?.assistant } })
		),
		history,
		input,
		operation,
		new AbortController().signal
	);
	permission.begin("actual-dispatch");
	assert.equal(gate.effects.length, 1);
});

test("clear fresh start with exact ingress evidence retains admission and existing-attempt guard", async () => {
	const gate = new WorkAdmission();
	const permission = await gate.authorize(
		client(JSON.stringify(accepted)),
		[],
		turn,
		operation,
		new AbortController().signal
	);
	assert.deepEqual(gate.effects, []);
	permission.begin("actual-dispatch");
	assert.throws(() => permission.begin("replay"), /already submitted/);
	const mustNotRun: AgentModelClient = {
		// biome-ignore lint/correctness/useYield: any provider invocation is a guard regression.
		async *stream() {
			assert.fail("Existing-attempt guard must run before model");
		},
	};
	await assert.rejects(
		gate.authorize(mustNotRun, [], turn, operation, new AbortController().signal),
		(error: unknown) =>
			error instanceof WorkAdmissionError && error.inspectExisting && error.diagnostic === undefined
	);
	assert.equal(gate.effects.length, 1);
});

// Controlled classifier responses exercise context/evidence wiring, not live model accuracy.
test("fresh rehearsal request supplies current ingress, matching brief and explicitly absent planning", async () => {
	const input = {
		...turn,
		text: "Build the MET-77 v1 now: persist on and off across refreshes and browser restarts on this device, no sync; keep the toggle usable in memory if storage is blocked. Keep the result local for review.",
	};
	const proposed = {
		...operation,
		brief:
			"Implement MET-77 v1: persist both focus-mode on and off on this device across refreshes and browser restarts. No sync. If storage is blocked, keep the toggle usable in memory. Keep changes local for review.",
	};
	const target = { ticketIdentifier: "MET-77", repository: "owner/repo" };
	const gate = new WorkAdmission();
	const permission = await gate.authorize(
		{
			async *stream(request, signal) {
				const context = JSON.parse(request.input[0]?.["content"] as string);
				assert.deepEqual(context.currentUser, { generation: 1, text: input.text });
				assert.deepEqual(context.users, [context.currentUser]);
				assert.deepEqual(context.dialogue, []);
				assert.equal(context.pendingQuestion, undefined);
				assert.deepEqual(context.proposedOperation, proposed);
				assert.deepEqual(context.observedTarget, target);
				assert.match(request.instructions, /No prior planning/);
				assert.match(request.instructions, /A mismatched brief is unresolved/);
				yield* client(JSON.stringify({ ...accepted, request: context.currentUser })).stream(
					request,
					signal
				);
			},
		},
		[],
		input,
		proposed,
		new AbortController().signal,
		target
	);
	permission.begin("fresh-rehearsal-start");
	assert.equal(gate.effects.length, 1);
});

for (const question of [
	"Would you like me to open the browser?",
	"Tab only or persist across restarts?",
]) {
	test(`self-contained current start can supersede remembered question evidence: ${question}`, async () => {
		const gate = new WorkAdmission();
		gate.observeReply(1, question);
		const input = { ...turn, generation: 3 };
		// The question survives history eviction. It is evidence, not a proven blocker.
		const permission = await gate.authorize(
			client(JSON.stringify({ ...accepted, request: { generation: 3, text: input.text } })),
			[],
			input,
			operation,
			new AbortController().signal
		);
		assert.deepEqual(gate.pendingQuestion, { generation: 1, text: question });
		permission.begin("new-explicit-start");
		assert.equal(gate.pendingQuestion, undefined);
		assert.equal(gate.effects.length, 1);
	});
}

test("current request evidence does not override classifier refusal for ambiguity or brief mismatch", async () => {
	for (const text of [
		"Start now.",
		"Continue",
		"As you",
		"What default do you suggest?",
		"Build tab-only persistence now, no storage across restarts.",
	]) {
		const gate = new WorkAdmission();
		gate.observeReply(1, "Tab only or persist across restarts? I suggest across restarts.");
		const input = { ...turn, generation: 2, text };
		await refusal(
			"scope-unresolved",
			client(
				JSON.stringify({
					...accepted,
					request: { generation: 2, text },
					scope: "unresolved",
				})
			),
			{ gate, input }
		);
	}
});

test("context limit is observable and cancellation is not mislabeled as a refusal", async () => {
	await refusal("context-limit", client("unused"), {
		input: { ...turn, text: "private".repeat(16000) },
	});
	const controller = new AbortController();
	const logs: unknown[][] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => {
		logs.push(args);
	};
	try {
		const gate = new WorkAdmission();
		const cancelled: AgentModelClient = {
			// biome-ignore lint/correctness/useYield: cancel before the provider emits an event.
			async *stream() {
				controller.abort();
				throw new Error("PRIVATE ERROR");
			},
		};
		await assert.rejects(
			gate.authorize(cancelled, [], turn, operation, controller.signal),
			(error: unknown) => !(error instanceof WorkAdmissionError)
		);
		assert.deepEqual(logs, []);
		assert.deepEqual(gate.effects, []);
	} finally {
		console.warn = original;
	}
});
