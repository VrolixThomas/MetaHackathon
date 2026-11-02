import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceObservation } from "../../shared/contracts";
import { ForegroundProfile } from "./foreground-profile";
import type { FunctionTool } from "./meta-client";

const tools: FunctionTool[] = [
	"open_command_center",
	"inspect_ticket",
	"inspect_work_job",
	"read_pinned_source",
	"search_pinned_source",
	"open_review_file",
	"confirm_pr_comment",
].map((name) => ({
	type: "function",
	name,
	description: "Controlled schema with existing pin requirements",
	parameters: { type: "object", required: ["pin"], properties: { pin: { type: "string" } } },
}));
function observation(section: "tickets" | "completed" | "home"): WorkspaceObservation {
	return {
		workspace: {
			sequence: 1,
			canvases: [{ id: section, kind: "center", title: section, section, revision: 1 }],
			primaryId: section,
			secondaryId: null,
			review: { sequence: 0, mode: "conversation", prId: null },
			codeView: "diff",
			browser: null,
		},
		browser: null,
		reviews: [],
		capabilities: ["center"],
	};
}

test("work questions can inspect pinned source without a capability-expansion model round", () => {
	for (const section of ["tickets", "completed"] as const) {
		const profile = new ForegroundProfile();
		profile.select(observation(section));
		const selected = profile.tools(tools);
		for (const name of ["read_pinned_source", "search_pinned_source", "inspect_work_job"])
			assert.equal(
				selected.find((tool) => tool.name === name),
				tools.find((tool) => tool.name === name)
			);
		assert(!selected.some((tool) => tool.name === "confirm_pr_comment"));
		assert(!selected.some((tool) => tool.name === "open_review_file"));
	}
});

test("unknown off-pane needs retain explicit expansion with unchanged authority", () => {
	const profile = new ForegroundProfile();
	profile.select(observation("home"));
	assert(!profile.tools(tools).some((tool) => tool.name === "read_pinned_source"));
	assert(profile.tools(tools).some((tool) => tool.name === "expand_tools"));
	const result = profile.expand(JSON.stringify({ families: ["reviews"] }));
	assert.match(result.authority, /not a user instruction or consent/);
	assert(profile.tools(tools).some((tool) => tool.name === "read_pinned_source"));
	profile.select(observation("tickets"));
	assert(!profile.tools(tools).some((tool) => tool.name === "open_review_file"));
});
