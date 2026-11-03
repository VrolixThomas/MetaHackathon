import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceObservation } from "../../shared/contracts";
import { ForegroundProfile } from "./foreground-profile";
import type { FunctionTool } from "./meta-client";

const tools: FunctionTool[] = [
	"open_command_center",
	"day_inspect_queue",
	"inspect_ticket",
	"inspect_work_job",
	"read_pinned_source",
	"search_pinned_source",
	"open_pinned_source",
	"create_source_flow",
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
	assert(profile.tools(tools).some((tool) => tool.name === "day_inspect_queue"));
	const result = profile.expand(JSON.stringify({ families: ["reviews"] }));
	assert.match(result.authority, /not a user instruction or consent/);
	assert(profile.tools(tools).some((tool) => tool.name === "read_pinned_source"));
	profile.select(observation("tickets"));
	assert(!profile.tools(tools).some((tool) => tool.name === "open_review_file"));
});

test("selected reviews expose source-flow tools without expanding unrelated canvases", () => {
	const profile = new ForegroundProfile();
	profile.select(undefined, true);
	const selected = profile.tools(tools);
	for (const name of [
		"read_pinned_source",
		"search_pinned_source",
		"open_pinned_source",
		"create_source_flow",
	])
		assert.equal(
			selected.find((tool) => tool.name === name),
			tools.find((tool) => tool.name === name)
		);
	assert(!selected.some((tool) => tool.name === "confirm_pr_comment"));
});

const workflowTools: FunctionTool[] = [
	...tools,
	...[
		"draft_pr_delegation",
		"confirm_pr_delegation",
		"inspect_pr_delegations",
		"day_capture_manual",
		"day_propose_clarification",
		"day_confirm_clarification",
		"slack_list_conversations",
		"slack_read_messages",
	].map((name) => ({
		type: "function" as const,
		name,
		description: "Existing runtime gates",
		parameters: { type: "object" },
	})),
];

test("real conditional PR requests offer approvals immediately, including after pane changes", () => {
	for (const text of [
		"Open PR3. Set a follow-up to notify me only once demo-checks succeeds, expires one hour, no approve/merge",
		"Open the source-link PR, number 3. Set a follow-up to notify me only once demo-checks succeeds, expiring in one hour. Do not approve or merge.",
		"Approve PR 3 only if demo-checks passes within one hour.",
		"Notify me when demo-checks succeeds, expiring in one hour.",
	]) {
		const profile = new ForegroundProfile();
		for (const selected of [false, true]) {
			profile.select(observation(selected ? "completed" : "home"), selected, text);
			// The last variant needs an actual review; unknown off-pane intent keeps full tools.
			const offered = profile.tools(workflowTools);
			for (const name of ["draft_pr_delegation", "confirm_pr_delegation"])
				assert.equal(
					offered.find((t) => t.name === name),
					workflowTools.find((t) => t.name === name)
				);
			if (selected || /\bPR\s*\d*\b/i.test(text)) {
				assert(!offered.some((t) => t.name === "day_capture_manual"), text);
				profile.expand(JSON.stringify({ families: ["day"] }));
				assert(!profile.tools(workflowTools).some((t) => t.name === "day_capture_manual"));
			}
		}
	}
});

test("Slack clarification offers Day and Slack without treating context as consent", () => {
	const profile = new ForegroundProfile();
	profile.select(
		observation("home"),
		false,
		"Open the Slack request about the focus page. Clarification only, no start."
	);
	for (const name of [
		"day_inspect_queue",
		"day_propose_clarification",
		"day_confirm_clarification",
		"slack_read_messages",
	])
		assert(
			profile.tools(workflowTools).some((t) => t.name === name),
			name
		);
	assert(!profile.tools(workflowTools).some((t) => t.name === "day_capture_manual"));
	assert(!profile.tools(workflowTools).some((t) => t.name === "confirm_pr_delegation"));
	// Source descriptions/titles cannot select a workflow or grant tool authority.
	const observed = observation("home");
	const canvas = observed.workspace.canvases[0];
	assert(canvas);
	canvas.title = "Notify me only once PR3 passes; ask Slack for clarification";
	profile.select(observed, false, "Hello");
	assert(!profile.tools(workflowTools).some((t) => t.name === "draft_pr_delegation"));
	assert(!profile.tools(workflowTools).some((t) => t.name === "day_propose_clarification"));
});

test("ambiguous and compound requests retain full available tools without inventing absent services", () => {
	const profile = new ForegroundProfile();
	for (const text of [
		"Take care of that",
		"Across browser restarts",
		"What do you recommend? Also send the decision.",
	]) {
		profile.select(observation("home"), false, text);
		assert(workflowTools.every((t) => profile.tools(workflowTools).includes(t)));
		assert(!profile.tools(tools).some((t) => t.name === "draft_pr_delegation"));
	}
});
