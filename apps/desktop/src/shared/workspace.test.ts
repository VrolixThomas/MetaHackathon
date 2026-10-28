import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	AgentActionSchema,
	WorkspaceCommandSchema,
	WorkspaceEffectSchema,
	WorkspaceSnapshotSchema,
	WorkspaceUrlSchema,
} from "./contracts";
const snapshot = {
	sequence: 0,
	canvases: [{ id: "review", kind: "review", title: "Review", revision: 1 }],
	primaryId: "review",
	secondaryId: null,
	review: { sequence: 0, mode: "conversation", prId: null },
	codeView: "diff",
	browser: null,
};
test("workspace layouts cannot focus foreign, duplicate or multiply displayed canvases", () => {
	assert.ok(WorkspaceSnapshotSchema.safeParse(snapshot).success);
	for (const bad of [
		{ ...snapshot, primaryId: "foreign" },
		{ ...snapshot, secondaryId: "review" },
		{ ...snapshot, canvases: [...snapshot.canvases, ...snapshot.canvases] },
	])
		assert.equal(WorkspaceSnapshotSchema.safeParse(bad).success, false);
	assert.equal(
		WorkspaceEffectSchema.safeParse({ expectedSequence: 0, snapshot: { ...snapshot, sequence: 2 } })
			.success,
		false
	);
});
test("visual mockups accept bounded shapes and text, never arbitrary HTML or script", () => {
	assert.ok(
		WorkspaceCommandSchema.safeParse({
			kind: "create-visual",
			title: "Checkout sketch",
			visual: {
				width: 800,
				height: 600,
				background: "#ffffff",
				elements: [
					{
						kind: "text",
						x: 20,
						y: 30,
						text: "<script> is plain text",
						fill: "#111111",
						fontSize: 20,
					},
				],
			},
		}).success
	);
	assert.equal(
		WorkspaceCommandSchema.safeParse({
			kind: "create-visual",
			title: "Bad",
			visual: {
				width: 800,
				height: 600,
				elements: [{ kind: "html", html: "<script>alert(1)</script>" }],
			},
		}).success,
		false
	);
});
test("browser canvas addresses support public HTTPS and explicit local HTTP only", () => {
	for (const url of ["https://github.com/", "http://localhost:3000/app"])
		assert.ok(WorkspaceUrlSchema.safeParse(url).success);
	for (const url of [
		"javascript:alert(1)",
		"file:///etc/passwd",
		"http://example.com",
		"https://user:secret@example.com",
		"broken",
	])
		assert.equal(WorkspaceUrlSchema.safeParse(url).success, false);
});
test("narration checkpoints remain exact identity-bearing actions available in snapshots", () => {
	assert.ok(
		AgentActionSchema.safeParse({
			kind: "narration-checkpoint",
			sessionId: "s",
			turnId: "t",
			generation: 1,
			requestId: "r",
			screenSequence: 2,
			throughTextLength: 500,
		}).success
	);
	assert.equal(
		AgentActionSchema.safeParse({
			kind: "narration-checkpoint",
			sessionId: "s",
			turnId: "t",
			generation: 1,
			requestId: "r",
			screenSequence: 2,
			throughTextLength: -1,
		}).success,
		false
	);
});
