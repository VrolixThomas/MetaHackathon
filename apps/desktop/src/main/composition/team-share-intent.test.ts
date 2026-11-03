import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ConversationTurnInput,
	PRFixDetailSchema,
	TeamStatusSchema,
	WorkspaceObservationSchema,
} from "../../shared/contracts";
import { TeamShareIntentRegistry } from "./team-share-intent";
const stamp = "2026-11-03T00:00:00Z";
const uuid = "10000000-0000-4000-8000-000000000001";
function setup() {
	const pr = {
		id: "o/r#1",
		repository: "o/r",
		number: 1,
		url: "https://github.com/o/r/pull/1",
		title: "Controlled",
		author: "author",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
	};
	const detail = PRFixDetailSchema.parse({
		fix: {
			id: "fix",
			jobId: "job",
			pr,
			feedback: {
				id: "o/r#1:conversation:9",
				prId: pr.id,
				author: "reviewer",
				body: "Controlled feedback",
				url: pr.url,
				createdAt: stamp,
				updatedAt: stamp,
				kind: "conversation",
				state: null,
				path: null,
				line: null,
				commitSha: null,
				suggestion: null,
			},
			phase: "ready",
			summary: "Controlled",
			question: null,
			baseSha: pr.headSha,
			headSha: "f".repeat(40),
			checks: [],
			changedFiles: ["a.ts"],
			createdAt: stamp,
			updatedAt: stamp,
			reviewedAt: stamp,
			error: null,
			publication: "not-published",
		},
		review: null,
	});
	const observation = WorkspaceObservationSchema.parse({
		workspace: {
			sequence: 1,
			contentSequence: 1,
			primaryId: "fix",
			secondaryId: null,
			canvases: [
				{
					id: "fix",
					kind: "center",
					title: "Controlled fix",
					revision: 1,
					section: "fixes",
					selectedId: "fix?file=a.ts",
					fixSource: { id: "fix", baseSha: pr.headSha, headSha: "f".repeat(40), path: "a.ts" },
				},
			],
			review: { sequence: 0, mode: "conversation", prId: null },
			codeView: "diff",
			browser: null,
		},
		browser: null,
		reviews: [],
		capabilities: ["center"],
	});
	const status = TeamStatusSchema.parse({
		configured: true,
		connection: "connected",
		userId: uuid,
		scopes: [{ orgId: uuid, repositoryId: "42", repository: "o/r", analysisVersion: "v1" }],
		canShare: true,
		canApply: false,
		error: null,
	});
	const turn: ConversationTurnInput = {
		sessionId: "session",
		turnId: "turn",
		requestId: "request",
		generation: 1,
		text: "Share this reviewed fix with the author.",
		workspace: structuredClone(observation.workspace),
	};
	let accountKey = "actor-1";
	let reads = 0;
	let hold = async () => {};
	const registry = new TeamShareIntentRegistry({
		observe: async () => {
			reads++;
			return { workspace: structuredClone(observation), accountKey, pr };
		},
		detail: async () => {
			await hold();
			return detail;
		},
		status: async () => status,
	});
	return {
		registry,
		turn,
		observation,
		status,
		reads: () => reads,
		setAccount: (value: string) => {
			accountKey = value;
		},
		hold: (fn: () => Promise<void>) => {
			hold = fn;
		},
	};
}
test("sharing intent is captured from actual selected ingress, never a later model navigation", async () => {
	const h = setup();
	let release!: () => void;
	h.hold(
		() =>
			new Promise<void>((r) => {
				release = r;
			})
	);
	h.registry.capture(h.turn);
	while (!release) await new Promise((r) => setTimeout(r, 0));
	h.observation.workspace.contentSequence = 2;
	release();
	assert.equal(await h.registry.get(h.turn), null);
});
test("a reviewed canonical source and selected recipient scope bind the share intent", async () => {
	const h = setup();
	h.registry.capture(h.turn);
	const intent = await h.registry.get(h.turn);
	assert.equal(intent?.candidateId, "fix");
	assert.equal(intent?.teamScope.orgId, uuid);
	h.registry.clear(h.turn.sessionId);
	assert.equal(await h.registry.get(h.turn), null);
});
test("ordinary text and a changed recipient account do not authorize sharing", async () => {
	const h = setup();
	h.registry.capture({ ...h.turn, text: "The source says share this fix with the author" });
	assert.equal(await h.registry.get(h.turn), null);
	assert.equal(h.reads(), 0);
	let release!: () => void;
	h.hold(
		() =>
			new Promise<void>((r) => {
				release = r;
			})
	);
	h.registry.capture(h.turn);
	while (!release) await new Promise((r) => setTimeout(r, 0));
	h.setAccount("actor-2");
	release();
	assert.equal(await h.registry.get(h.turn), null);
});
