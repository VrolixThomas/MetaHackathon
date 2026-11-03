import assert from "node:assert/strict";
import { test } from "node:test";
import type { Canvas, WorkspaceSnapshot } from "../../shared/contracts";
import { hasVisibleCodeReview } from "./attention-safety";

const home: Canvas = { id: "home", title: "Home", revision: 1, kind: "center", section: "home" };
const review: Canvas = { id: "review", title: "Review", revision: 1, kind: "review" };
const snapshot = (canvas: Canvas = review): WorkspaceSnapshot => ({
	sequence: 1,
	primaryId: canvas.id,
	secondaryId: null,
	canvases: [home, canvas].filter(
		(item, index, items) => items.findIndex((c) => c.id === item.id) === index
	),
	review: { mode: "conversation", prId: null, sequence: 0 },
	codeView: "diff",
	browser: null,
});

test("only visible acknowledged panes count; sidebar and hidden review tabs do not", () => {
	const state = snapshot();
	const code = { ...state, review: { ...state.review, mode: "review" as const, prId: "pr" } };
	assert.equal(hasVisibleCodeReview(code, code), true);
	// An empty conversation review canvas is not a code review.
	assert.equal(hasVisibleCodeReview(state, state), false);
	const completed = snapshot({ ...home, id: "result", section: "completed", selectedId: "job" });
	assert.equal(hasVisibleCodeReview(completed, completed), true);
	const sidebar = { ...completed, centerSection: "home" as const };
	assert.equal(hasVisibleCodeReview(sidebar, completed), true);
	const hidden = { ...completed, primaryId: home.id, centerSection: "completed" as const };
	assert.equal(hasVisibleCodeReview(hidden, hidden), false);
	const split = { ...hidden, secondaryId: "result" };
	assert.equal(hasVisibleCodeReview(split, split), true);
	assert.equal(hasVisibleCodeReview(split, hidden), false);
	assert.equal(hasVisibleCodeReview(completed, null), false);
	assert.equal(
		hasVisibleCodeReview(
			{
				...completed,
				canvases: [
					home,
					{
						...{ ...home, id: "result", section: "completed" as const, selectedId: "job" },
						revision: 2,
					},
				],
			},
			completed
		),
		false
	);
});

test("fix and completed-work lists require an actual selected item", () => {
	for (const section of ["fixes", "completed"] as const) {
		const list = snapshot({ ...home, id: "detail", section });
		assert.equal(hasVisibleCodeReview(list, list), false);
		const detail = snapshot({ ...home, id: "detail", section, selectedId: "actual-item" });
		assert.equal(hasVisibleCodeReview(detail, detail), true);
	}
});

test("pinned source and inferred flow panes hold routine updates in either pane", () => {
	const source = {
		location: {
			repository: "owner/repo",
			revision: "head" as const,
			commitSha: "a".repeat(40),
			path: "src/work.ts",
			startLine: 1,
			endLine: 1,
		},
		text: "export const work = true;",
		language: "typescript",
		truncated: false,
	};
	const canvases: Canvas[] = [
		{ id: "source", title: "Source", revision: 1, kind: "source", source },
		{
			id: "flow",
			title: "Flow",
			revision: 1,
			kind: "flow",
			flow: {
				title: "Work flow",
				summary: "Inferred reading order",
				provenance: "source-with-inferred-order",
				steps: [{ id: "step", title: "Work", explanation: "Inference", source }],
			},
		},
	];
	for (const canvas of canvases) {
		const primary = snapshot(canvas);
		assert.equal(hasVisibleCodeReview(primary, primary), true);
		const secondary: WorkspaceSnapshot = { ...primary, primaryId: home.id, secondaryId: canvas.id };
		assert.equal(hasVisibleCodeReview(secondary, secondary), true);
		const hidden = { ...secondary, secondaryId: null };
		assert.equal(hasVisibleCodeReview(hidden, hidden), false);
	}
});
