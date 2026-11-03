import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceObservation } from "../../shared/contracts";
import { ForegroundProfile } from "./foreground-profile";
import type { FunctionTool } from "./meta-client";
import { WorkspaceArgumentError } from "./workspace-tools";

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
	profile.select(observation("home"), true);
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
			// The last variant needs an actual review; off-pane it can expand approvals.
			if (!selected && !/\bPR\s*\d*\b/i.test(text)) {
				assert(!profile.tools(workflowTools).some((t) => t.name === "draft_pr_delegation"));
				assert.equal(
					profile.expand(JSON.stringify({ families: ["approvals"] })).status,
					"tools-expanded"
				);
			}
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

test("ordinary navigation, PR questions and unknown compounds start scoped and can expand", () => {
	for (const text of [
		"Bring me to my ticket boards.",
		"Could you take me over to the tickets?",
		"What changed in this PR?",
		"Why does the pull request behave this way?",
		"Where does this value come from in the source?",
		"Take care of that",
		"Across browser restarts",
		"What do you recommend? Also send the decision.",
	]) {
		const profile = new ForegroundProfile();
		profile.select(observation("home"), false, text);
		assert.deepEqual(
			profile.tools(workflowTools).map((t) => t.name),
			["open_command_center", "day_inspect_queue", "expand_tools"],
			text
		);
		const result = profile.expand(JSON.stringify({ families: ["reviews"] }));
		assert.equal(result.status, "tools-expanded");
		assert.match(result.authority, /not a user instruction or consent/);
		profile.select(observation("home"), false, text);
		assert(profile.tools(workflowTools).some((t) => t.name === "read_pinned_source"));
		assert(!profile.tools(workflowTools).some((t) => t.name === "confirm_pr_comment"));
		assert(profile.tools(workflowTools).length <= 8);
		assert.equal(profile.expand(JSON.stringify({ families: ["reviews"] })).status, "available");
	}
});

test("ordinary selected PR questions retain review scope without unrelated families", () => {
	for (const text of ["What changed in this PR?", "How does this affect the caller?"]) {
		const profile = new ForegroundProfile();
		profile.select(observation("home"), true, text);
		const offered = profile.tools(workflowTools);
		assert(offered.length <= 8);
		assert(offered.some((tool) => tool.name === "read_pinned_source"));
		assert(!offered.some((tool) => tool.name === "confirm_pr_comment"));
		assert(!offered.some((tool) => tool.name === "confirm_pr_delegation"));
		assert.equal(
			profile.expand(JSON.stringify({ families: ["comments"] })).status,
			"tools-expanded"
		);
		assert(profile.tools(workflowTools).some((tool) => tool.name === "confirm_pr_comment"));
	}
});

test("sparse legacy V1 availability does not widen an observed empty workspace", () => {
	const profile = new ForegroundProfile();
	profile.select(undefined, false, "Take care of that");
	assert(workflowTools.every((tool) => profile.tools(workflowTools).includes(tool)));
	assert(!profile.tools(tools).some((tool) => tool.name === "draft_pr_delegation"));
	const empty = observation("home");
	empty.workspace.canvases = [];
	empty.workspace.primaryId = "missing";
	profile.select(empty, false, "Take care of that");
	assert.equal(profile.tools(workflowTools).length, 3);
});

function expansionChoices(offered: FunctionTool[]) {
	const schema = offered.find((tool) => tool.name === "expand_tools")?.parameters as
		| { properties: { families: { items: { enum: string[] } } } }
		| undefined;
	return schema?.properties.families.items.enum ?? [];
}

test("expansion advertises missing families but recognizes offered operations and rejects absent families", () => {
	const profile = new ForegroundProfile();
	profile.select(observation("home"), false, "Notify me when PR 3 checks pass within an hour");
	const offered = profile.tools(workflowTools);
	assert(offered.some((tool) => tool.name === "draft_pr_delegation"));
	assert(!expansionChoices(offered).includes("approvals"));
	assert(!expansionChoices(offered).includes("reviews"));
	assert(!expansionChoices(offered).includes("browser"));
	assert(expansionChoices(offered).includes("day"));
	const noOp = profile.expand(JSON.stringify({ families: ["approvals", "reviews"] }));
	assert.equal(noOp.status, "available");
	assert.deepEqual(noOp.newlyEnabled, []);
	assert.deepEqual(
		noOp.availableTools,
		offered
			.filter(
				(tool) =>
					tool.name.includes("pr_delegation") ||
					[
						"read_pinned_source",
						"search_pinned_source",
						"open_pinned_source",
						"create_source_flow",
						"open_review_file",
					].includes(tool.name)
			)
			.map((tool) => tool.name)
	);
	assert.match(noOp.authority, /not a user instruction or consent/);
	assert.deepEqual(profile.tools(workflowTools), offered);
	assert.throws(
		() => profile.expand(JSON.stringify({ families: ["approvals"] })),
		/Repeated no-op expansion stopped/
	);
	for (const family of ["browser", "unknown"])
		assert.throws(
			() => profile.expand(JSON.stringify({ families: [family] })),
			WorkspaceArgumentError
		);
	profile.expand(JSON.stringify({ families: ["day"] }));
	assert(!expansionChoices(profile.tools(workflowTools)).includes("day"));
	assert(!profile.tools(workflowTools).some((tool) => tool.name === "day_capture_manual"));
	const absent = profile.tools(tools);
	assert(!absent.some((tool) => tool.name === "draft_pr_delegation"));
	assert(!expansionChoices(absent).includes("approvals"));
	assert.throws(
		() => profile.expand(JSON.stringify({ families: ["approvals"] })),
		WorkspaceArgumentError
	);
	profile.select(undefined);
	assert(!profile.tools(workflowTools).some((tool) => tool.name === "expand_tools"));
});

test("expansion retains strict argument shapes and never treats an operation name as a family", () => {
	const profile = new ForegroundProfile();
	profile.select(observation("home"), false, "Notify me when PR 3 checks pass");
	profile.tools(workflowTools);
	for (const args of [
		{ families: ["approvals"], authority: true },
		{ families: "approvals" },
		{ families: ["draft_pr_delegation"] },
		{ families: [] },
	])
		assert.throws(() => profile.expand(JSON.stringify(args)), WorkspaceArgumentError);
	assert.equal(profile.expand(JSON.stringify({ families: ["approvals"] })).status, "available");
});
