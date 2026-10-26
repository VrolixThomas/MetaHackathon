import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AgentActionSchema,
	AgentTurnInputSchema,
	CancelTurnInputSchema,
	CancelTurnResultSchema,
	CodeLocationSchema,
	ConfirmCommentInputSchema,
	DiagramSpecSchema,
	EvidenceSchema,
	ExecutionEvidenceSchema,
	PRPreparationSchema,
	PreviewSchema,
	ScenarioTraceSchema,
	VoiceStateSchema,
	WhyNoteSchema,
} from ".";
import { ReviewFixtureSchema, getReviewFixture } from "../fixtures/review";

const execution = {
	kind: "execution" as const,
	runId: "run-1",
	commitSha: "1".repeat(40),
	command: ["bun", "test"],
	startedAt: "2026-10-26T12:00:00Z",
	completedAt: "2026-10-26T12:00:01Z",
	exitCode: 0,
	logUrl: "file:///tmp/run-1.log",
};

describe("review contract boundaries", () => {
	it("round-trips deterministic fixtures through JSON without sharing mutable state", () => {
		const first = getReviewFixture();
		assert.deepEqual(ReviewFixtureSchema.parse(JSON.parse(JSON.stringify(first))), first);
		assert.deepEqual(getReviewFixture(), first);
		first.preparation.files.splice(0);
		assert.equal(getReviewFixture().preparation.files.length, 6);
	});

	it("labels every fixture evidence object and cannot treat one as executed evidence", () => {
		const fixture = getReviewFixture();
		const inspect = (value: unknown): void => {
			if (value === null || typeof value !== "object") return;
			if ("evidence" in value) {
				const evidence = EvidenceSchema.parse(value.evidence);
				assert.equal(evidence.kind, "fixture");
				assert.equal(ExecutionEvidenceSchema.safeParse(evidence).success, false);
			}
			for (const child of Object.values(value)) inspect(child);
		};
		inspect(fixture);
		assert.equal(ExecutionEvidenceSchema.safeParse({ kind: "execution" }).success, false);
		assert.equal(
			ExecutionEvidenceSchema.safeParse({ ...execution, completedAt: "2026-10-26T11:59:59Z" })
				.success,
			false
		);
	});

	it("rejects unsafe paths and code ranges that cannot synchronize highlights", () => {
		const location = getReviewFixture().scenario.after.steps[3]?.location;
		assert.ok(location);
		for (const path of ["/etc/passwd", "../secret", "src/../secret", "src\\file.ts", "a//b"]) {
			assert.equal(CodeLocationSchema.safeParse({ ...location, path }).success, false, path);
		}
		for (const change of [{ startLine: 0 }, { endLine: 1 }, { commitSha: "HEAD" }]) {
			assert.equal(CodeLocationSchema.safeParse({ ...location, ...change }).success, false);
		}
	});

	it("requires an intent citation for recorded Why notes and rejects stale PR references", () => {
		const prep = getReviewFixture().preparation;
		const note = prep.whyNotes[0];
		assert.ok(note);
		assert.equal(
			WhyNoteSchema.safeParse({ ...note, provenance: { kind: "recorded", sources: [] } }).success,
			false
		);
		assert.equal(
			WhyNoteSchema.safeParse({ ...note, provenance: { kind: "inferred", sources: [] } }).success,
			false
		);
		assert.equal(
			PRPreparationSchema.safeParse({
				...prep,
				whyNotes: [{ ...note, location: { ...note.location, commitSha: "3".repeat(40) } }],
			}).success,
			false
		);
	});

	it("requires successful runs on the current base and head to verify mechanical files", () => {
		const prep = getReviewFixture().preparation;
		const file = prep.files[5];
		assert.ok(file);
		const verified = {
			...file,
			category: "mechanical-verified",
			behaviorCheck: {
				base: execution,
				head: { ...execution, runId: "run-2", commitSha: prep.pr.headSha },
			},
		};
		assert.equal(
			PRPreparationSchema.safeParse({ ...prep, files: [...prep.files.slice(0, 5), verified] })
				.success,
			true
		);
		for (const behaviorCheck of [
			undefined,
			{ ...verified.behaviorCheck, head: { ...verified.behaviorCheck.head, exitCode: 1 } },
			{ ...verified.behaviorCheck, head: execution },
		]) {
			assert.equal(
				PRPreparationSchema.safeParse({
					...prep,
					files: [...prep.files.slice(0, 5), { ...verified, behaviorCheck }],
				}).success,
				false
			);
		}
	});

	it("keeps scenario C base/head evidence separate and validates the split position", () => {
		const trace = getReviewFixture().scenario;
		assert.equal(trace.divergenceIndex, 3);
		assert.equal(trace.before.steps[3]?.values["totalCents"], 10800);
		assert.equal(trace.after.steps[3]?.outcome, "throw");
		assert.equal(trace.after.steps[4]?.values["reminderSent"], false);
		for (const change of [
			{ before: trace.after },
			{ divergenceIndex: 5 },
			{ after: { ...trace.after, evidence: execution } },
		])
			assert.equal(ScenarioTraceSchema.safeParse({ ...trace, ...change }).success, false);
	});

	it("rejects dangling diagram edges, duplicate preview markers and remote previews", () => {
		const { diagram, preview } = getReviewFixture();
		assert.equal(
			DiagramSpecSchema.safeParse({ ...diagram, edges: [{ from: "missing", to: "discount" }] })
				.success,
			false
		);
		assert.equal(
			PreviewSchema.safeParse({ ...preview, markers: [...preview.markers, ...preview.markers] })
				.success,
			false
		);
		for (const url of [
			"https://example.com/checkout",
			"file:///etc/passwd",
			"http://localhost.attacker.test",
		]) {
			assert.equal(PreviewSchema.safeParse({ ...preview, url }).success, false);
		}
		assert.ok(preview.markers.some((marker) => marker.bounds.y > preview.viewport.height));
	});

	it("requires explicit comment confirmation with the draft revision, exact body and head", () => {
		const { confirmation, draftComment } = getReviewFixture();
		assert.equal(confirmation.body, draftComment.body);
		assert.equal(confirmation.draftRevision, draftComment.revision);
		for (const change of [
			{ confirmed: false },
			{ draftRevision: 0 },
			{ body: undefined },
			{ headSha: undefined },
		]) {
			assert.equal(
				ConfirmCommentInputSchema.safeParse({ ...confirmation, ...change }).success,
				false
			);
		}
	});

	it("carries screen context and cancellable turn identity across voice and agent boundaries", () => {
		const { agentTurn, actions, voiceState, cancellation } = getReviewFixture();
		assert.equal(
			AgentTurnInputSchema.safeParse({ ...agentTurn, screenContext: undefined }).success,
			false
		);
		assert.equal(
			AgentActionSchema.safeParse({ ...actions[0], kind: "post-comment" }).success,
			false
		);
		assert.equal(
			VoiceStateSchema.safeParse({ ...voiceState, phase: "speaking", turnId: null }).success,
			false
		);
		assert.equal(
			CancelTurnInputSchema.safeParse({ ...cancellation, generation: -1 }).success,
			false
		);
		assert.equal(
			CancelTurnResultSchema.safeParse({ ...cancellation, reason: undefined, status: "cancelled" })
				.success,
			false
		);
		const { reason: _reason, ...identity } = cancellation;
		assert.equal(CancelTurnResultSchema.safeParse({ ...identity, status: "stale" }).success, true);
		for (const action of actions) {
			assert.equal(action.sessionId, voiceState.sessionId);
			assert.equal(action.turnId, voiceState.turnId);
			assert.equal(action.generation, cancellation.generation);
		}
	});
});
