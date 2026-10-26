import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	type AgentAction,
	type AgentEvent,
	AgentEventSchema,
	EvidenceSchema,
	ExecutionEvidenceSchema,
	type GeneratedScenario,
	GeneratedScenarioSchema,
	MAX_AGENT_EVENTS_PER_POLL,
	PollTurnResultSchema,
	PollTurnSchema,
	ScenarioTraceSchema,
} from ".";

const identity = { sessionId: "session-1", turnId: "turn-2", generation: 2 };
const action: AgentAction = {
	...identity,
	requestId: "request-2",
	screenSequence: 3,
	kind: "highlight-code",
	location: {
		repository: "example/review",
		revision: "head",
		commitSha: "2".repeat(40),
		path: "src/checkout.ts",
		startLine: 10,
		endLine: 12,
	},
	note: "Inspect the discount boundary",
};
const actionEvent: AgentEvent = { ...identity, sequence: 3, kind: "action", action };
const events: AgentEvent[] = [
	{ ...identity, sequence: 1, kind: "acknowledgement", text: "Checking the discount." },
	{ ...identity, sequence: 2, kind: "text-delta", delta: "The boundary changed." },
	actionEvent,
	{ ...identity, sequence: 4, kind: "completed" },
];
const pollResult = {
	...identity,
	status: "completed",
	sequence: 4,
	events,
	text: "The boundary changed.",
	actions: [action],
};

function generatedScenario(): GeneratedScenario {
	const source = 'import assert from "node:assert/strict";\nassert.equal(1 + 1, 2);\n';
	return {
		plan: {
			id: "discount-boundary",
			pr: {
				id: "pr-1",
				repository: "example/review",
				number: 1,
				url: "https://github.com/example/review/pull/1",
				title: "Change discount threshold",
				author: "review-author",
				baseSha: "1".repeat(40),
				headSha: "2".repeat(40),
			},
			title: "Discount applies at the threshold",
			origin: {
				kind: "ticket",
				criterion: "A total of 100 receives the discount",
				source: {
					kind: "ticket",
					url: "https://example.com/tickets/discount",
					excerpt: "Apply the discount at the threshold",
					evidence: {
						kind: "source",
						url: "https://example.com/tickets/discount",
						retrievedAt: "2026-10-26T12:00:00Z",
					},
				},
			},
			inputs: { total: 100, options: { enabled: true }, overrides: [null, 0] },
			modulePath: "src/checkout.ts",
			exportName: "discount",
			anchor: "export function discount",
			arguments: [100],
			expectation: { path: ["returnValue"], equals: 90, description: "Discount is ten percent" },
		},
		filename: "tests/scenario-discount-boundary.mjs",
		source,
		sourceSha256: createHash("sha256").update(source).digest("hex"),
		execution: "not-run",
	};
}

describe("agent event polling contracts", () => {
	it("round-trips every event kind and full snapshots through JSON", () => {
		const allEvents: AgentEvent[] = [
			...events,
			{ ...identity, sequence: 4, kind: "cancelled" },
			{ ...identity, sequence: 4, kind: "error", message: "Model unavailable" },
		];
		for (const event of allEvents) {
			assert.deepEqual(AgentEventSchema.parse(JSON.parse(JSON.stringify(event))), event);
		}
		assert.deepEqual(
			PollTurnResultSchema.parse(JSON.parse(JSON.stringify(pollResult))),
			pollResult
		);
		assert.equal(AgentEventSchema.safeParse({ ...events[0], kind: "unknown" }).success, false);
		assert.equal(AgentEventSchema.safeParse({ ...events[0], status: "running" }).success, false);
		assert.equal(
			AgentEventSchema.safeParse({ ...identity, sequence: 1, kind: "error" }).success,
			false
		);
	});

	it("rejects stale or foreign identities in nested actions, events and snapshots", () => {
		for (const stale of [{ sessionId: "other" }, { turnId: "turn-1" }, { generation: 1 }]) {
			assert.equal(
				AgentEventSchema.safeParse({ ...actionEvent, action: { ...action, ...stale } }).success,
				false
			);
			assert.equal(
				PollTurnResultSchema.safeParse({ ...pollResult, events: [{ ...events[0], ...stale }] })
					.success,
				false
			);
			assert.equal(
				PollTurnResultSchema.safeParse({ ...pollResult, actions: [{ ...action, ...stale }] })
					.success,
				false
			);
		}
		assert.equal(
			AgentEventSchema.safeParse({
				...actionEvent,
				action: { ...action, location: { ...action.location, startLine: 0 } },
			}).success,
			false
		);
	});

	it("defaults the initial cursor and bounds polling without coercing malformed values", () => {
		assert.deepEqual(PollTurnSchema.parse(identity), {
			...identity,
			afterSequence: 0,
			limit: MAX_AGENT_EVENTS_PER_POLL,
		});
		for (const afterSequence of [
			-1,
			0.5,
			"1",
			null,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			2 ** 53,
		]) {
			assert.equal(PollTurnSchema.safeParse({ ...identity, afterSequence }).success, false);
		}
		for (const limit of [0, -1, 0.5, "1", null, MAX_AGENT_EVENTS_PER_POLL + 1]) {
			assert.equal(PollTurnSchema.safeParse({ ...identity, limit }).success, false);
		}
		assert.equal(PollTurnSchema.parse({ ...identity, afterSequence: 3, limit: 1 }).limit, 1);
	});

	it("accepts partial terminal pages and empty repeat polls while validating ordering and bounds", () => {
		assert.equal(
			PollTurnResultSchema.safeParse({ ...pollResult, events: events.slice(0, 2) }).success,
			true
		);
		assert.equal(PollTurnResultSchema.safeParse({ ...pollResult, events: [] }).success, true);
		for (const invalidEvents of [
			[events[1], events[0]],
			[events[0], events[0]],
			[{ ...events[0], sequence: 0 }],
			[{ ...events[0], sequence: 1.5 }],
			[{ ...events[0], sequence: 5 }],
		]) {
			assert.equal(
				PollTurnResultSchema.safeParse({ ...pollResult, events: invalidEvents }).success,
				false
			);
		}
		const oversizedEvents = Array.from({ length: MAX_AGENT_EVENTS_PER_POLL + 1 }, (_, index) => ({
			...identity,
			sequence: index + 1,
			kind: "text-delta",
			delta: ".",
		}));
		assert.equal(
			PollTurnResultSchema.safeParse({
				...pollResult,
				sequence: oversizedEvents.length,
				events: oversizedEvents,
			}).success,
			false
		);
	});

	it("requires terminal events to match final status and prevents stale poll data leaks", () => {
		for (const kind of ["completed", "cancelled", "error"] as const) {
			const terminal = {
				...identity,
				sequence: 4,
				kind,
				...(kind === "error" ? { message: "Failed" } : {}),
			};
			const result = { ...pollResult, status: kind, events: [terminal] };
			assert.equal(PollTurnResultSchema.safeParse(result).success, true);
			assert.equal(PollTurnResultSchema.safeParse({ ...result, status: "running" }).success, false);
			assert.equal(PollTurnResultSchema.safeParse({ ...result, sequence: 5 }).success, false);
		}
		const stale = { ...identity, status: "stale", sequence: 0, events: [], text: "", actions: [] };
		assert.equal(PollTurnResultSchema.safeParse(stale).success, true);
		for (const data of [
			{ sequence: 1 },
			{ events: [events[0]] },
			{ text: "old" },
			{ actions: [action] },
		]) {
			assert.equal(PollTurnResultSchema.safeParse({ ...stale, ...data }).success, false);
		}
	});
});

describe("generated scenario contracts", () => {
	it("round-trips the lane plan, source, pinned PR and JSON inputs for each origin", () => {
		const generated = generatedScenario();
		for (const origin of [
			generated.plan.origin,
			{ kind: "reviewer", requestId: "request-2", originalWords: "Try a total of 100" },
			{ kind: "agent", rationale: "Probe the changed discount boundary" },
		]) {
			const value = { ...generated, plan: { ...generated.plan, origin } };
			assert.deepEqual(GeneratedScenarioSchema.parse(JSON.parse(JSON.stringify(value))), value);
		}
	});

	it("requires unrun status and rejects generated data as execution evidence or a trace", () => {
		const generated = generatedScenario();
		for (const execution of [undefined, "execution", "completed", "passed"]) {
			assert.equal(GeneratedScenarioSchema.safeParse({ ...generated, execution }).success, false);
		}
		const executionEvidence = {
			kind: "execution",
			runId: "run-1",
			commitSha: generated.plan.pr.headSha,
			command: ["node", generated.filename],
			startedAt: "2026-10-26T12:00:00Z",
			completedAt: "2026-10-26T12:00:01Z",
			exitCode: 0,
			logUrl: "file:///tmp/scenario.log",
		};
		assert.equal(ExecutionEvidenceSchema.safeParse(executionEvidence).success, true);
		assert.equal(
			GeneratedScenarioSchema.safeParse({ ...generated, evidence: executionEvidence }).success,
			false
		);
		const origin = generated.plan.origin;
		assert.equal(origin.kind, "ticket");
		if (origin.kind !== "ticket") throw new Error("Expected ticket sample");
		const withPriorRunCitation = GeneratedScenarioSchema.parse({
			...generated,
			plan: {
				...generated.plan,
				origin: { ...origin, source: { ...origin.source, evidence: executionEvidence } },
			},
		});
		assert.equal(withPriorRunCitation.execution, "not-run");
		for (const schema of [EvidenceSchema, ExecutionEvidenceSchema, ScenarioTraceSchema]) {
			assert.equal(schema.safeParse(generated).success, false);
		}
	});

	it("requires ticket criteria and citations, reviewer words or an agent rationale", () => {
		const generated = generatedScenario();
		const ticket = generated.plan.origin;
		if (ticket.kind !== "ticket") throw new Error("Expected ticket sample");
		for (const origin of [
			{ ...ticket, criterion: "" },
			{ ...ticket, source: undefined },
			{ ...ticket, source: { ...ticket.source, kind: "code" } },
			{ ...ticket, source: { ...ticket.source, evidence: undefined } },
			{ kind: "reviewer", requestId: "request-2", originalWords: "" },
			{ kind: "agent", rationale: "" },
		]) {
			assert.equal(
				GeneratedScenarioSchema.safeParse({ ...generated, plan: { ...generated.plan, origin } })
					.success,
				false
			);
		}
		const fixtureOrigin = {
			...ticket,
			source: {
				...ticket.source,
				evidence: { kind: "fixture", fixtureId: "ticket-example", label: "Illustrative ticket" },
			},
		};
		assert.equal(
			GeneratedScenarioSchema.safeParse({
				...generated,
				plan: { ...generated.plan, origin: fixtureOrigin },
			}).success,
			true
		);
	});

	it("rejects unsafe expectation paths at any depth while allowing array indexes", () => {
		const generated = generatedScenario();
		for (const key of ["__proto__", "constructor", "prototype"]) {
			for (const path of [[key], ["returnValue", key, 0]]) {
				assert.equal(
					GeneratedScenarioSchema.safeParse({
						...generated,
						plan: { ...generated.plan, expectation: { ...generated.plan.expectation, path } },
					}).success,
					false
				);
			}
		}
		assert.equal(
			GeneratedScenarioSchema.safeParse({
				...generated,
				plan: {
					...generated.plan,
					expectation: { ...generated.plan.expectation, path: ["arguments", 0, "total"] },
				},
			}).success,
			true
		);
	});

	it("rejects unsafe filenames, unpinned revisions, malformed digests and non-JSON inputs", () => {
		const generated = generatedScenario();
		for (const filename of [
			"/tmp/test.mjs",
			"../test.mjs",
			"tests/../test.mjs",
			"tests\\test.mjs",
			"test.ts",
			"tests//test.mjs",
		]) {
			assert.equal(GeneratedScenarioSchema.safeParse({ ...generated, filename }).success, false);
		}
		for (const revision of [{ baseSha: "main" }, { headSha: undefined }, { headSha: "123abcd" }]) {
			assert.equal(
				GeneratedScenarioSchema.safeParse({
					...generated,
					plan: { ...generated.plan, pr: { ...generated.plan.pr, ...revision } },
				}).success,
				false
			);
		}
		assert.equal(
			GeneratedScenarioSchema.safeParse({ ...generated, sourceSha256: "bad" }).success,
			false
		);
		assert.equal(GeneratedScenarioSchema.safeParse({ ...generated, source: "" }).success, false);
		for (const value of [undefined, Number.NaN, BigInt(1), new Date()]) {
			assert.equal(
				GeneratedScenarioSchema.safeParse({
					...generated,
					plan: { ...generated.plan, inputs: { value } },
				}).success,
				false
			);
		}
	});
});
