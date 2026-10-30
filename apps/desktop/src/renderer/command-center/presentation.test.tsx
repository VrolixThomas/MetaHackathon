import assert from "node:assert/strict";
import { it } from "node:test";
import { Children, type ReactNode, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type CenterSection,
	type HubOperation,
	type HubSnapshot,
	HubSnapshotSchema,
	type PinnedSource,
	WorkReviewSchema,
	type WorkspaceCommand,
	WorkspaceSnapshotSchema,
} from "../../shared/contracts";
import { createPreparedApi } from "../prepared/api";
import { createPreparedController } from "../prepared/controller";
import { highlightSource } from "../prepared/highlighting";
import { createWorkspaceController } from "../workspace/controller";
import { createLocalBrowserController } from "../workspace/local-browser";
import { CenterCanvas } from "./CenterCanvas";
import { Connections } from "./Connections";
import { CommandSidebar } from "./Sidebar";
import { FlowCanvas, SourceBlock, exactSourceRows } from "./SourceCanvas";
import { WorkAcceptance, WorkDiff, loadedReviewMatchesJob } from "./WorkViews";
import { createHubController } from "./controller";
import {
	centerSections,
	jobOutcomeLabel,
	jobReference,
	jobTitle,
	priorityItems,
	sectionCount,
} from "./model";

const stamp = "2026-10-28T12:00:00.000Z";
const sha = "a".repeat(40);
const makeSnapshot = () =>
	HubSnapshotSchema.parse({
		sequence: 3,
		refreshedAt: stamp,
		refreshing: false,
		viewer: { githubLogin: "test-user", linearName: "Test User" },
		connections: { github: true, linear: true, model: true },
		repositories: [
			{
				id: "repo",
				repository: "test/project",
				localPath: "/test/project",
				defaultBranch: "main",
				addedAt: stamp,
			},
		],
		reviews: ["incoming", "own"].map((kind, index) => ({
			pr: {
				id: `pr-${index}`,
				number: index + 1,
				repository: "test/project",
				title: kind === "incoming" ? "Requested change" : "Owned change",
				author: kind === "own" ? "test-user" : "colleague",
				url: `https://github.com/test/project/pull/${index + 1}`,
				baseSha: sha,
				headSha: "b".repeat(40),
			},
			repositoryId: "repo",
			kind,
			baseBranch: "main",
			headBranch: `change-${index}`,
			updatedAt: stamp,
			draft: false,
			reviewState: "requested",
			feedbackCount: kind === "own" ? 2 : 0,
			lastFeedbackAt: null,
		})),
		tickets: [
			{
				id: "ticket",
				identifier: "TEST-1",
				title: "Assigned change",
				url: "https://linear.app/test/issue/TEST-1",
				updatedAt: stamp,
				state: { id: "state", name: "Todo", type: "unstarted" },
				priority: 1,
				teamId: "team",
				teamName: "Test team",
				projectId: null,
				projectName: null,
				assigneeId: "user",
				assigneeName: "Test User",
			},
		],
		jobs: [],
		notices: [],
		preferences: { linearTeamIds: ["team"], linearProjectIds: [], maxWorkers: 2 },
		errors: [],
	});
function summary(state: "ready" | "needs-input", id: string) {
	return {
		id,
		repositoryId: "repo",
		repository: "test/project",
		ticket: null,
		state,
		branch: `work/${id}`,
		worktreePath: null,
		baseSha: sha,
		headSha: sha,
		summary: "",
		createdAt: stamp,
		updatedAt: stamp,
		pullRequest: null,
		error: null,
		pendingDecisions: state === "needs-input" ? 1 : 0,
		changedFileCount: 2,
	};
}
function suppliedHub(snapshot: HubSnapshot) {
	const hub = createHubController(async () => {
		throw new Error("No external calls in presentation test");
	});
	hub.store.setState({ snapshot });
	return { ...hub, store: { ...hub.store, getInitialState: hub.store.getState } };
}
function suppliedWorkspace(
	section: CenterSection,
	displayedSection = section,
	selectedId = displayedSection === "feedback" ? "pr-1" : "pr-0"
) {
	const call = async () => null;
	const reviews = createPreparedController(createPreparedApi(call), "test-session");
	const browser = createLocalBrowserController(call);
	const workspace = createWorkspaceController(call, reviews, browser, "test-session");
	workspace.store.setState({
		workspace: WorkspaceSnapshotSchema.parse({
			sequence: 2,
			centerSection: section,
			primaryId: "center",
			secondaryId: null,
			review: { sequence: 0, mode: "conversation", prId: null },
			browser: null,
			canvases: [
				{
					id: "center",
					kind: "center",
					section: displayedSection,
					selectedId,
					title: "Work",
					revision: 1,
				},
			],
		}),
	});
	return { ...workspace, store: { ...workspace.store, getInitialState: workspace.store.getState } };
}

type ButtonProps = {
	children?: ReactNode;
	"aria-label"?: string;
	onClick?(): void;
};
function nodeText(node: ReactNode): string {
	return Children.toArray(node)
		.map((child) =>
			isValidElement<{ children?: ReactNode }>(child)
				? nodeText(child.props.children)
				: typeof child === "string" || typeof child === "number"
					? String(child)
					: ""
		)
		.join("");
}
/** Capture the sidebar's own controls during SSR, with React's real hook dispatcher. */
function sidebarControls(
	hub: ReturnType<typeof suppliedHub>,
	workspace: ReturnType<typeof suppliedWorkspace>
) {
	const buttons: ButtonProps[] = [];
	function collect(node: ReactNode) {
		Children.forEach(node, (child) => {
			if (!isValidElement<ButtonProps>(child)) return;
			if (child.type === "button") buttons.push(child.props);
			collect(child.props.children);
		});
	}
	function CaptureSidebar() {
		const element = CommandSidebar({
			hub,
			workspace,
			conversationOpen: false,
			onConversation() {},
			onSettings() {},
		});
		collect(element);
		return element;
	}
	const html = renderToStaticMarkup(<CaptureSidebar />);
	return {
		html,
		click(label: string) {
			const matches = buttons.filter(
				(button) => button["aria-label"] === label || nodeText(button.children).includes(label)
			);
			assert.equal(matches.length, 1, `Expected one sidebar control for ${label}`);
			const click = matches[0]?.onClick;
			assert.ok(click);
			click();
		},
	};
}

it("keeps incoming reviews separate from feedback on own PRs and exposes current selection", () => {
	const hub = suppliedHub(makeSnapshot());
	const incoming = renderToStaticMarkup(
		<CommandSidebar
			hub={hub}
			workspace={suppliedWorkspace("reviews")}
			conversationOpen={false}
			onConversation={() => {}}
			onSettings={() => {}}
		/>
	);
	assert.match(incoming, /Requested change/);
	assert.doesNotMatch(incoming, /Owned change/);
	assert.match(incoming, /aria-current="true"/);
	assert.match(incoming, /<summary>.*project.*1<\/span>/);
	const own = renderToStaticMarkup(
		<CommandSidebar
			hub={hub}
			workspace={suppliedWorkspace("feedback")}
			conversationOpen={false}
			onConversation={() => {}}
			onSettings={() => {}}
		/>
	);
	assert.match(own, /Owned change/);
	assert.match(own, /2 feedback/);
	assert.doesNotMatch(own, /Requested change/);
	assert.match(own, /aria-expanded="false"/);
	hub.dispose();
});

it("uses one counted rail and browses categories independently of the selected main detail", () => {
	const snapshot = makeSnapshot();
	snapshot.jobs = [summary("ready", "saved"), summary("needs-input", "active")];
	const hub = suppliedHub(snapshot);
	const commands: WorkspaceCommand[] = [];
	const workspace = {
		...suppliedWorkspace("reviews", "feedback", "pr-1"),
		command: async (input: WorkspaceCommand) => {
			commands.push(input);
			return "applied" as const;
		},
	};
	const before = workspace.store.getState().workspace;
	assert.ok(before);
	const canvas = before.canvases[0];
	assert.ok(canvas?.kind === "center");
	const renderMain = () =>
		renderToStaticMarkup(<CenterCanvas canvas={canvas} hub={hub} command={() => {}} />);
	const main = renderMain();
	const sidebar = sidebarControls(hub, workspace);
	assert.match(sidebar.html, /<header><strong>Incoming reviews<\/strong>/);
	assert.match(sidebar.html, /Requested change/);
	assert.doesNotMatch(
		sidebar.html,
		/Owned change|command-sections|aria-label="Your work"|aria-current="true"/
	);
	assert.equal((sidebar.html.match(/aria-current="page"/g) ?? []).length, 1);
	assert.equal(
		(sidebar.html.match(/class="command-rail-count"/g) ?? []).length,
		centerSections.length
	);
	for (const section of centerSections) {
		const label = `${section.label} (${sectionCount(snapshot, section.id)})`;
		assert.ok(sidebar.html.includes(`title="${label}" aria-label="${label}"`));
		sidebar.click(label);
		assert.deepEqual(commands.pop(), {
			kind: section.id === "home" ? "open-center" : "browse-center",
			section: section.id,
		});
	}
	sidebar.click("Open Home");
	assert.deepEqual(commands.pop(), { kind: "open-center", section: "home" });
	assert.equal(workspace.store.getState().workspace, before);
	// Adopt a category-only acknowledgement while the feedback detail stays selected.
	workspace.store.setState({
		workspace: { ...before, sequence: before.sequence + 1, centerSection: "tickets" },
	});
	const browsed = sidebarControls(hub, workspace).html;
	assert.match(browsed, /<header><strong>My tickets<\/strong>/);
	assert.match(browsed, /Assigned change/);
	assert.doesNotMatch(browsed, /Requested change|Owned change/);
	assert.equal(renderMain(), main);
	assert.match(main, /data-center-section="feedback" data-selected-id="pr-1"/);
	assert.match(main, /Owned change|Open code review/);
	assert.doesNotMatch(main, /hub-back|Back to|hub-list-row/);
	hub.dispose();
});

it("keeps actual item commands for ready reviews, preparation details, own feedback, tickets and jobs", () => {
	const snapshot = makeSnapshot();
	snapshot.jobs = [summary("ready", "saved"), summary("needs-input", "active")];
	const hub = suppliedHub(snapshot);
	const commands: WorkspaceCommand[] = [];
	function workspace(section: CenterSection) {
		return {
			...suppliedWorkspace(section),
			command: async (input: WorkspaceCommand) => {
				commands.push(input);
				return "applied" as const;
			},
		};
	}
	const incoming = snapshot.reviews[0];
	assert.ok(incoming);
	for (const status of ["ready", "queued", "preparing", "error"] as const) {
		incoming.preparationStatus = status;
		const sidebar = sidebarControls(hub, workspace("reviews"));
		sidebar.click("Requested change");
		assert.deepEqual(
			commands.pop(),
			status === "ready"
				? { kind: "show-review", prId: "pr-0" }
				: { kind: "open-center", section: "reviews", selectedId: "pr-0" }
		);
		if (status === "queued" || status === "preparing")
			assert.match(sidebar.html, /Preparing review/);
		if (status === "error") assert.match(sidebar.html, /Preparation needs retry/);
	}
	for (const [section, label, selectedId] of [
		["feedback", "Owned change", "pr-1"],
		["tickets", "Assigned change", "ticket"],
		["completed", "work/saved", "saved"],
		["activity", "work/active", "active"],
	] as const) {
		sidebarControls(hub, workspace(section)).click(label);
		assert.deepEqual(commands.pop(), { kind: "open-center", section, selectedId });
	}
	hub.dispose();
});

it("shows each non-Home queue only in the sidebar and leaves selection guidance in the main pane", () => {
	const snapshot = makeSnapshot();
	snapshot.jobs = [summary("ready", "saved"), summary("needs-input", "active")];
	const hub = suppliedHub(snapshot);
	for (const section of centerSections.filter((item) => item.id !== "home")) {
		const sidebar = sidebarControls(hub, suppliedWorkspace(section.id)).html;
		const main = renderToStaticMarkup(
			<CenterCanvas
				canvas={{
					id: "center",
					kind: "center",
					section: section.id,
					title: section.label,
					revision: 1,
				}}
				hub={hub}
				command={() => {}}
			/>
		);
		assert.match(sidebar, /class="command-item quiet"/);
		assert.match(main, /Select a (ticket|pull request|job) in the sidebar/);
		assert.doesNotMatch(
			main,
			/hub-list-row|hub-repo-section|hub-back|Back to|Requested change|Owned change|Assigned change|work\/saved|work\/active/
		);
		assert.equal((sidebar.match(/class="command-sidebar-scroll"/g) ?? []).length, 1);
	}
	hub.dispose();
});

it("retains selected review preparation, feedback, ticket and job views without back-to-list controls", () => {
	const snapshot = makeSnapshot();
	snapshot.jobs = [summary("ready", "saved")];
	const hub = suppliedHub(snapshot);
	const render = (section: CenterSection, selectedId: string) =>
		renderToStaticMarkup(
			<CenterCanvas
				canvas={{ id: "center", kind: "center", section, selectedId, title: "Work", revision: 1 }}
				hub={hub}
				command={() => {}}
			/>
		);
	const incoming = snapshot.reviews[0];
	assert.ok(incoming);
	for (const status of ["queued", "preparing", "error", "ready"] as const) {
		incoming.preparationStatus = status;
		const html = render("reviews", "pr-0");
		assert.match(html, /Requested change/);
		assert.doesNotMatch(html, /hub-back|Back to|hub-list-row|Owned change/);
		assert.match(
			html,
			status === "error"
				? /Retry review preparation/
				: status === "ready"
					? /Open code review/
					: /<button[^>]*disabled=""[^>]*>Preparing code review/
		);
	}
	assert.match(
		render("feedback", "pr-1"),
		/Owned change.*Feedback on your pull request.*Loading feedback/s
	);
	assert.match(render("tickets", "ticket"), /Loading ticket/);
	assert.match(render("completed", "saved"), /Loading saved job/);
	const missing = render("tickets", "retired-ticket");
	assert.match(missing, /no longer in your workspace.*select another item in the sidebar/s);
	assert.doesNotMatch(missing, /Back to|hub-back/);
	hub.dispose();
});

it("builds a priority brief from actual pending decisions, ready jobs, own feedback, reviews and tickets", () => {
	const snapshot = makeSnapshot();
	snapshot.jobs = [summary("ready", "ready"), summary("needs-input", "question")];
	const items = priorityItems(snapshot);
	assert.deepEqual(
		items.map((item) => item.id),
		["decision:question", "ready:ready", "feedback:pr-1", "review:pr-0", "ticket:ticket"]
	);
	assert.equal(jobTitle(snapshot.jobs[0] as NonNullable<(typeof snapshot.jobs)[0]>), "work/ready");
	assert.equal(
		jobReference(snapshot.jobs[0] as NonNullable<(typeof snapshot.jobs)[0]>),
		"work/ready"
	);
	const hub = suppliedHub(snapshot);
	const html = renderToStaticMarkup(
		<CenterCanvas
			canvas={{ id: "home", kind: "center", section: "home", title: "Home", revision: 1 }}
			hub={hub}
			command={() => {}}
		/>
	);
	assert.match(html, /Needs your input/);
	assert.match(html, /Ready to inspect/);
	assert.match(html, /Feedback on your PR/);
	assert.match(html, /Assigned change/);
	assert.doesNotMatch(html, /No assigned tickets|No saved outcomes|hub-metrics|hub-list-row/);
	hub.dispose();
});

it("empty startup and failed reads show honest connection states without synthetic product items", () => {
	const hub = createHubController(async () => null);
	const html = renderToStaticMarkup(
		<CenterCanvas
			canvas={{ id: "home", kind: "center", section: "home", title: "Home", revision: 1 }}
			hub={hub}
			command={() => {}}
		/>
	);
	assert.match(html, /Loading your work/);
	assert.doesNotMatch(html, /Requested change|Owned change|Assigned change|hub-priority quiet/);
	const empty = makeSnapshot();
	empty.reviews = [];
	empty.tickets = [];
	empty.repositories = [];
	const loaded = suppliedHub(empty);
	const state = renderToStaticMarkup(
		<CenterCanvas
			canvas={{ id: "home", kind: "center", section: "home", title: "Home", revision: 1 }}
			hub={loaded}
			command={() => {}}
		/>
	);
	assert.match(state, /Bring your work into view/);
	assert.doesNotMatch(state, /Requested change|Owned change|Assigned change/);
	hub.dispose();
	loaded.dispose();
});

it("distinguishes empty, disconnected and failed queues without duplicating source items", () => {
	const snapshot = makeSnapshot();
	snapshot.reviews = [];
	snapshot.tickets = [];
	const hub = suppliedHub(snapshot);
	const render = (section: CenterSection) =>
		renderToStaticMarkup(
			<CenterCanvas
				canvas={{ id: "center", kind: "center", section, title: "Work", revision: 1 }}
				hub={hub}
				command={() => {}}
			/>
		);
	for (const [section, message] of [
		["reviews", /No incoming review requests/],
		["feedback", /No own pull requests/],
		["tickets", /No assigned tickets/],
		["completed", /No saved outcomes/],
		["activity", /No coding jobs/],
	] as const)
		assert.match(render(section), message);
	snapshot.connections.github = false;
	snapshot.connections.linear = false;
	assert.match(render("reviews"), /Connect GitHub.*Manage connections/s);
	assert.match(render("tickets"), /Connect Linear.*Manage connections/s);
	assert.match(
		sidebarControls(hub, suppliedWorkspace("reviews")).html,
		/Connect GitHub to refresh pull requests/
	);
	assert.match(
		sidebarControls(hub, suppliedWorkspace("tickets")).html,
		/Connect Linear to load your assigned tickets/
	);
	snapshot.connections.github = true;
	snapshot.connections.linear = true;
	snapshot.errors = [
		{ source: "github", message: "GitHub read unavailable" },
		{ source: "linear", message: "Linear read unavailable" },
	];
	for (const section of ["reviews", "feedback", "tickets"] as const) {
		const main = render(section);
		assert.match(main, /This queue could not be refreshed/);
		assert.doesNotMatch(main, /No incoming|No own|No assigned/);
		const sidebar = sidebarControls(hub, suppliedWorkspace(section)).html;
		assert.match(sidebar, /read unavailable.*could not be refreshed/s);
		assert.doesNotMatch(sidebar, /No requested reviews|No own PRs|No assigned tickets/);
	}
	snapshot.errors = [];
	snapshot.repositories = [];
	assert.match(render("reviews"), /Add a repository.*Manage connections/s);
	hub.store.setState({ snapshot: null, error: "Saved work is unavailable" });
	assert.match(
		render("home"),
		/Saved work is unavailable.*Your work is unavailable.*Check your connections/s
	);
	hub.dispose();
});

it("keeps Activity update actions in its contextual sidebar without a duplicate main feed", () => {
	const snapshot = makeSnapshot();
	snapshot.notices = [
		{
			id: "notice",
			kind: "work-ready",
			title: "Saved worker update",
			detail: "A recorded worker result",
			jobId: "saved",
			prId: null,
			createdAt: stamp,
			announcedAt: null,
			seenAt: null,
		},
	];
	const operations: HubOperation[] = [];
	const hub = {
		...suppliedHub(snapshot),
		operate: async (operation: HubOperation) => {
			operations.push(operation);
			return null;
		},
	};
	const commands: WorkspaceCommand[] = [];
	const workspace = {
		...suppliedWorkspace("activity"),
		command: async (input: WorkspaceCommand) => {
			commands.push(input);
			return "applied" as const;
		},
	};
	const sidebar = sidebarControls(hub, workspace);
	assert.match(sidebar.html, /Saved worker update.*A recorded worker result/s);
	sidebar.click("Open update: Saved worker update");
	assert.deepEqual(commands.pop(), {
		kind: "open-center",
		section: "activity",
		selectedId: "saved",
	});
	sidebar.click("Mark update read: Saved worker update");
	assert.deepEqual(operations.pop(), { kind: "seen-notice", noticeId: "notice" });
	const main = renderToStaticMarkup(
		<CenterCanvas
			canvas={{ id: "center", kind: "center", section: "activity", title: "Activity", revision: 1 }}
			hub={hub}
			command={() => {}}
		/>
	);
	assert.doesNotMatch(main, /Saved worker update|hub-notice/);
	hub.dispose();
});

const source: PinnedSource = {
	location: {
		repository: "test/project",
		revision: "head",
		commitSha: sha,
		path: "src/first.ts",
		startLine: 7,
		endLine: 9,
	},
	text: '\tconst html = "<script>";\r\n\nreturn html;\n',
	language: "typescript",
	truncated: false,
};
it("source and continuous flow retain exact bytes, pinned identity, ordered snippets, and line actions", async () => {
	assert.equal(exactSourceRows(source.text).join(""), source.text);
	for (const text of ["", "\n", "a\r\n\r\n", "é\t<>&", "a\n\n"])
		assert.equal(exactSourceRows(text).join(""), text);
	const html = renderToStaticMarkup(<SourceBlock source={source} onReference={() => {}} />);
	assert.match(html, /data-source-line="7"/);
	assert.match(html, /data-source-line="9"/);
	assert.match(html, /data-source-sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/);
	assert.match(html, /&lt;script&gt;/);
	assert.doesNotMatch(html, /<script>/);
	const colored = await highlightSource({
		path: source.location.path,
		commitSha: sha,
		status: "available",
		content: source.text,
	});
	assert.equal(
		colored.lines[0]?.map((token) => token.content).join(""),
		'\tconst html = "<script>";\r'
	);
	assert.ok(colored.lines[0]?.some((token) => token.color));
	const flow = renderToStaticMarkup(
		<FlowCanvas
			flow={{
				title: "Observed source flow",
				summary: "A bounded explanation",
				provenance: "source-with-inferred-order",
				steps: [
					{ id: "first", title: "Entry", explanation: "Inferred entry", source },
					{
						id: "second",
						title: "Consumer",
						explanation: "Inferred consumer",
						source: { ...source, location: { ...source.location, path: "src/consumer.ts" } },
					},
				],
			}}
			onReference={() => {}}
		/>
	);
	assert.match(flow, /<ol class="hub-flow-steps">/);
	assert.ok(flow.indexOf("src/first.ts") < flow.indexOf("src/consumer.ts"));
	assert.match(flow, /inferred reading order/);
	assert.equal((flow.match(/class="hub-source"/g) ?? []).length, 2);
});

function localReview() {
	const snapshot = makeSnapshot();
	const ticket = snapshot.tickets[0];
	assert.ok(ticket);
	const {
		pendingDecisions: _decisions,
		changedFileCount: _count,
		...localJob
	} = summary("ready", "local");
	return WorkReviewSchema.parse({
		job: {
			...localJob,
			headSha: "b".repeat(40),
			ticket: { ...ticket, description: "Supplied ticket" },
			brief: "Supplied brief",
			checks: [],
			changedFiles: ["src/first.ts"],
			decisions: [],
		},
		files: [
			{
				path: "src/first.ts",
				status: "modified",
				patch: "@@ -1 +1 @@\n-old()\n+new()",
				base: { path: "src/first.ts", commitSha: sha, status: "available", content: "old()\n" },
				head: {
					path: "src/first.ts",
					commitSha: "b".repeat(40),
					status: "available",
					content: "new()\n",
				},
			},
		],
	});
}

it("local work diff uses real base/head source and never requires an invented PR identity", () => {
	const review = localReview();
	assert.equal("prId" in (review.files[0] ?? {}), false);
	const html = renderToStaticMarkup(<WorkDiff review={review} command={() => {}} />);
	assert.match(html, /old\(\)/);
	assert.match(html, /new\(\)/);
	assert.match(html, /Open base src\/first.ts line 1/);
	assert.match(html, /Open head src\/first.ts line 1/);
	assert.doesNotMatch(html, /Open PR|pull\/0|prId/);
});

it("acceptance stays disabled until the loaded local review matches the current job and pinned revisions", () => {
	const review = localReview();
	const render = (loaded: typeof review | null) =>
		renderToStaticMarkup(
			<WorkAcceptance job={review.job} review={loaded} busy={false} operate={async () => null} />
		);
	assert.equal(loadedReviewMatchesJob(review.job, null), false);
	assert.match(render(null), /<button[^>]*disabled=""[^>]*>Accept work and complete ticket/);
	const stale = { ...review, job: { ...review.job, headSha: "c".repeat(40) } };
	assert.equal(loadedReviewMatchesJob(review.job, stale), false);
	assert.match(render(stale), /<button[^>]*disabled=""[^>]*>Accept work and complete ticket/);
	assert.equal(
		loadedReviewMatchesJob(review.job, { ...review, job: { ...review.job, id: "other-job" } }),
		false
	);
	assert.equal(loadedReviewMatchesJob(review.job, review), true);
	assert.match(render(review), /<button type="button">Accept work and complete ticket/);
	assert.match(render(review), /Requested changes/);
	assert.match(render(review), /Request changes/);
});

it("accepted outcomes leave Home's pending-ready brief and count without inventing an applied result", () => {
	const review = localReview();
	const accepted = { ...review.job, reviewedAt: stamp };
	const html = renderToStaticMarkup(
		<WorkAcceptance job={accepted} review={review} busy={false} operate={async () => null} />
	);
	assert.match(html, /Accepted/);
	assert.doesNotMatch(html, /Accept work and complete ticket|Applied|Published head/);
	assert.equal(jobOutcomeLabel(accepted), "Accepted");
	const snapshot = makeSnapshot();
	snapshot.jobs = [
		{ ...summary("ready", "ready"), reviewedAt: stamp },
		summary("ready", "pending"),
	];
	assert.equal(sectionCount(snapshot, "home"), 1);
	assert.deepEqual(
		priorityItems(snapshot)
			.filter((item) => item.id.startsWith("ready:"))
			.map((item) => item.selectedId),
		["pending"]
	);
	const published = { ...review.job, publishedHeadSha: sha };
	assert.equal(jobOutcomeLabel(published), "ready");
	const publishedHtml = renderToStaticMarkup(
		<WorkAcceptance job={published} review={review} busy={false} operate={async () => null} />
	);
	assert.match(publishedHtml, /Published head/);
	assert.doesNotMatch(publishedHtml, /Applied/);
	const applied = { ...published, feedbackAppliedAt: stamp };
	assert.equal(jobOutcomeLabel(applied), "Applied");
	assert.match(
		renderToStaticMarkup(
			<WorkAcceptance job={applied} review={review} busy={false} operate={async () => null} />
		),
		/Applied/
	);
});

it("ticket, completed and activity sidebars focus their own lists without repository groups", () => {
	const snapshot = makeSnapshot();
	snapshot.jobs = [summary("ready", "saved"), summary("needs-input", "active")];
	const hub = suppliedHub(snapshot);
	for (const section of ["tickets", "completed", "activity"] as const) {
		const html = renderToStaticMarkup(
			<CommandSidebar
				hub={hub}
				workspace={suppliedWorkspace(section)}
				conversationOpen={false}
				onConversation={() => {}}
				onSettings={() => {}}
			/>
		);
		assert.doesNotMatch(html, /class="command-repo"|Requested change|Owned change/);
		assert.match(
			html,
			section === "tickets"
				? /Assigned change/
				: section === "completed"
					? /work\/saved/
					: /work\/active/
		);
		if (section === "tickets") assert.doesNotMatch(html, /work\/saved|work\/active/);
	}
	hub.dispose();
});

it("repository entry remains available while optional repository suggestions load", () => {
	const hub = suppliedHub(makeSnapshot());
	const html = renderToStaticMarkup(<Connections hub={hub} />);
	assert.match(html, /<input[^>]*type="text"[^>]*list="[^"]+"[^>]*placeholder="owner\/repository"/);
	const repositoryInput = html.match(/<input[^>]*placeholder="owner\/repository"[^>]*>/)?.[0] ?? "";
	assert.doesNotMatch(repositoryInput, /disabled/);
	assert.match(html, /<datalist/);
	assert.match(html, /GitHub verifies access/);
	hub.dispose();
});

it("Home's sidebar lists canvases without repeating the executive brief's work items", () => {
	const hub = suppliedHub(makeSnapshot());
	const workspace = suppliedWorkspace("home");
	const html = sidebarControls(hub, workspace).html;
	assert.match(html, /Recent canvases/);
	assert.doesNotMatch(html, /Requested change|Owned change|Assigned change|Up next/);
	hub.dispose();
	workspace.dispose();
});
