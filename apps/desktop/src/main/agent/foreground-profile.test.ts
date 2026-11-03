import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceObservation } from "../../shared/contracts";
import { ForegroundProfile, SOURCE_WORKFLOW_INSTRUCTIONS } from "./foreground-profile";
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
	assert(profile.tools(tools).some((tool) => tool.name === "open_review_file"));
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

test("workflow packet selection uses actual ingress and pane, leaving source-only questions on legacy paths", () => {
	assert(Buffer.byteLength(SOURCE_WORKFLOW_INSTRUCTIONS, "utf8") <= 1800);
	const profile = new ForegroundProfile();
	for (const text of [
		"How does the PR approval flow work when checks pass?",
		"Explain the code that asks a Slack requester for clarification.",
		"Show me the entire flow from the request to delivering an update.",
	]) {
		profile.select(observation("home"), true, text);
		assert.equal(profile.sourceWorkflow, false, text);
		assert(profile.tools(workflowTools).some((tool) => tool.name === "read_pinned_source"));
	}
	for (const text of [
		"Notify me when checks pass within one hour.",
		"Explain the condition and draft a PR approval when checks pass.",
	]) {
		profile.select(observation("home"), true, text);
		assert.equal(profile.sourceWorkflow, true, text);
	}
	const pane = observation("home");
	const canvas = pane.workspace.canvases[0];
	assert(canvas?.kind === "center");
	canvas.section = "day";
	profile.select(pane, false, "Ask the requester which page they mean.");
	assert.equal(profile.sourceWorkflow, true);
	profile.select(pane, false, "How does the clarification code work?");
	assert.equal(profile.sourceWorkflow, false);
});

test("no-op allowance is per ingress turn and survives workspace-to-review handoff", () => {
	const profile = new ForegroundProfile();
	profile.beginTurn("first");
	profile.select(observation("home"), true, "Notify me when checks pass");
	profile.tools(workflowTools);
	assert.equal(profile.expand(JSON.stringify({ families: ["approvals"] })).status, "available");
	profile.beginTurn("first");
	profile.tools(workflowTools);
	assert.throws(
		() => profile.expand(JSON.stringify({ families: ["approvals"] })),
		/Repeated no-op/
	);
	profile.beginTurn("next");
	profile.tools(workflowTools);
	assert.equal(profile.expand(JSON.stringify({ families: ["approvals"] })).status, "available");
	profile.tools([]);
	assert.throws(
		() => profile.expand(JSON.stringify({ families: ["approvals"] })),
		WorkspaceArgumentError
	);
});

test("actual suggested-fix intent offers candidate readers without unrelated capabilities", () => {
	const available = [
		...workflowTools,
		...["inspect_suggested_fixes", "inspect_suggested_fix"].map((name) => ({
			type: "function" as const,
			name,
			description: "Existing owner and source guards",
			parameters: { type: "object" },
		})),
	];
	for (const text of [
		"Open the prepared Slack-capture suggested fix and explain the behavioral correction. Keep unpublished.",
		"Why is the local fix different?",
		"Do not open the suggested fix yet.",
	]) {
		const profile = new ForegroundProfile();
		profile.select(observation("home"), false, text);
		assert.equal(profile.candidateWorkflow, true);
		assert(profile.tools(available).some((tool) => tool.name === "inspect_suggested_fix"));
		assert(!profile.tools(available).some((tool) => tool.name === "inspect_ticket"));
		assert(Buffer.byteLength(profile.workflowInstructions) < 1800);
	}
	const profile = new ForegroundProfile();
	const observed = observation("home");
	assert(observed.workspace.canvases[0]);
	observed.workspace.canvases[0].title = "Open the prepared suggested fix";
	profile.select(observed, false, "Hello");
	assert.equal(profile.candidateWorkflow, false);
	assert(!profile.tools(available).some((tool) => tool.name === "inspect_suggested_fix"));
});

test("expansions survive same-request handoff and sidebar revisions, then reset for the next ingress", () => {
	const profile = new ForegroundProfile();
	profile.beginTurn("draft");
	profile.select(observation("home"), false, "Follow this up");
	profile.tools(workflowTools);
	profile.expand(JSON.stringify({ families: ["approvals", "comments"] }));
	profile.beginTurn("draft");
	const pane = observation("home");
	pane.workspace.sequence++;
	profile.select(pane, true, "Follow this up");
	for (const name of ["confirm_pr_delegation", "confirm_pr_comment"])
		assert(profile.tools(workflowTools).some((tool) => tool.name === name));
	profile.beginTurn("next");
	profile.select(pane, true, "What changed?");
	for (const name of ["confirm_pr_delegation", "confirm_pr_comment"])
		assert(!profile.tools(workflowTools).some((tool) => tool.name === name));
	profile.beginTurn("confirmation");
	profile.select(pane, false, "Confirm this delegation");
	assert(profile.sourceWorkflow);
	assert(profile.tools(workflowTools).some((tool) => tool.name === "confirm_pr_delegation"));
	assert(!profile.tools(workflowTools).some((tool) => tool.name === "confirm_pr_comment"));
	assert(!profile.tools(workflowTools).some((tool) => tool.name === "inspect_ticket"));
	assert(!profile.tools(workflowTools).some((tool) => tool.name === "day_capture_manual"));
	profile.select(pane, false, 'The source says "Confirm this delegation"');
	assert(!profile.tools(workflowTools).some((tool) => tool.name === "confirm_pr_delegation"));
});

for (const text of [
	"Build the MET-77 v1 now.",
	"Please implement ticket DEMO-42.",
	"Can you work on the ticket TASK-12 now?",
	"Start MET-77.",
]) {
	test(`explicit ticket action exposes unchanged registered work tools: ${text}`, () => {
		const start: FunctionTool = {
			type: "function",
			name: "start_work",
			description: "Actual admission still required",
			parameters: { type: "object" },
		};
		const profile = new ForegroundProfile();
		profile.select(observation("home"), false, text);
		assert.equal(
			profile.tools([...tools, start]).find((t) => t.name === "start_work"),
			start
		);
		assert(profile.has("work"));
	});
}
for (const text of [
	"Do not build MET-77.",
	"They said build MET-77.",
	'"Build MET-77 now."',
	"What would building MET-77 involve?",
]) {
	test(`off-pane non-action does not select coding tools from text: ${text}`, () => {
		const profile = new ForegroundProfile();
		profile.select(observation("home"), false, text);
		assert(!profile.has("work"));
	});
}
