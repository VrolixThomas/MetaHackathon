import assert from "node:assert/strict";
import { test } from "node:test";
import { Children, type ReactNode, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	HubSnapshotSchema,
	type PRFixDetail,
	type ReviewFile,
	type WorkspaceCommand,
	WorkspaceSnapshotSchema,
	encodePRFixViewTarget,
} from "../../shared/contracts";
import { CenterCanvas } from "../command-center/CenterCanvas";
import { CommandSidebar } from "../command-center/Sidebar";
import { WorkDiff } from "../command-center/WorkViews";
import { createHubController } from "../command-center/controller";
import { createPreparedApi } from "../prepared/api";
import { createPreparedController } from "../prepared/controller";
import { highlightSource } from "../prepared/highlighting";
import { createWorkspaceController } from "../workspace/controller";
import { createLocalBrowserController } from "../workspace/local-browser";
import {
	PRFixList,
	PRFixReview,
	PRFixView,
	PrepareSuggestedFixButton,
	prepareSuggestedFix,
} from "./PRFixView";
import { diffLineCounts } from "./model";
import { deferred, fixDetail, harness, ssrController } from "./test-support";

function text(node: ReactNode): string {
	return Children.toArray(node)
		.map((child) =>
			isValidElement<{ children?: ReactNode }>(child)
				? text(child.props.children)
				: typeof child === "string" || typeof child === "number"
					? String(child)
					: ""
		)
		.join("");
}
function buttons(
	node: ReactNode
): Array<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }> {
	const result: Array<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }> = [];
	Children.forEach(node, (child) => {
		if (isValidElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }>(child)) {
			if (child.type === "button") result.push(child.props);
			result.push(...buttons(child.props.children));
		}
	});
	return result;
}

test("Previous/Next file controls use actual adjacent candidate paths", () => {
	const detail = fixDetail();
	assert.ok(detail.review);
	const review = detail.review;
	for (const [selectedPath, label, expected] of [
		["src/main.ts", "Next file", "empty.test.ts"],
		["empty.test.ts", "Previous file", "src/main.ts"],
	]) {
		const selected: string[] = [];
		let controls: ReturnType<typeof buttons> = [];
		function Capture() {
			const element = WorkDiff({
				review,
				command() {},
				selectedPath,
				navigation: true,
				onSelectFile: (path) => selected.push(path),
			});
			controls = buttons(element);
			return element;
		}
		renderToStaticMarkup(<Capture />);
		const button = controls.find((control) => text(control.children) === label);
		assert.ok(button?.onClick);
		assert.equal(button.disabled, false);
		button.onClick();
		assert.deepEqual(selected, [expected]);
	}
});

test("metadata-only patches never claim candidate code was displayed", async () => {
	const h = harness();
	const detail: PRFixDetail = fixDetail();
	assert.ok(detail.review);
	for (const file of detail.review.files) file.patch = "old mode 100644\nnew mode 100755";
	h.setDetail(detail);
	await h.controller.ensureTarget("fix-1");
	const html = renderToStaticMarkup(
		<PRFixView
			controller={ssrController(h.controller)}
			selectedId="fix-1"
			onNavigate={() => {}}
			command={() => {}}
		/>
	);
	assert.doesNotMatch(html, /data-pr-fix-id=/);
	assert.match(html, /data-pr-fix-status-id="fix-1"/);
	assert.match(html, /disabled="">Mark fix reviewed/);
});
function matching(html: string) {
	assert.match(html, /data-pr-fix-id="fix-1"/);
	assert.match(html, /data-pr-fix-head="c{40}"/);
	assert.match(html, /data-pr-fix-base="b{40}"/);
	assert.match(html, /data-pr-fix-path="src\/main.ts"/);
}

test("exact loaded candidate shows original feedback, agent summary, real counts, diff and actual checks", async () => {
	const h = harness();
	await h.controller.ensureTarget("fix-1");
	const html = renderToStaticMarkup(
		<PRFixView
			controller={ssrController(h.controller)}
			selectedId="fix-1"
			onNavigate={() => {}}
			command={() => {}}
		/>
	);
	matching(html);
	for (const phrase of [
		"Original feedback",
		"Original PR head",
		"Agent summary",
		"Original words.",
		"Before",
		"Proposed after",
		"Previous file",
		"Next file",
		"File 1 of 2",
		"+2 −1",
		"bun test empty.test.ts",
		"Exit 0",
		"Mark fix reviewed",
		"not published",
		"no author approval",
	])
		assert.ok(html.includes(phrase), phrase);
	assert.match(html, /if \(!input\) return;/);
	assert.equal(h.calls.length, 1, "Rendering makes no calls");
	assert.doesNotMatch(html, />Apply|>Publish|>Merge|>Send|>Accept work/);
});

test("empty, loading, wrong selection and missing review never claim candidate source displayed", async () => {
	const h = harness();
	let html = renderToStaticMarkup(
		<PRFixView
			controller={ssrController(h.controller)}
			selectedId="fix-1"
			command={() => {}}
			onNavigate={() => {}}
		/>
	);
	assert.doesNotMatch(html, /data-pr-fix-id=/);
	await h.controller.ensureTarget("fix-1");
	html = renderToStaticMarkup(
		<PRFixView
			controller={ssrController(h.controller)}
			selectedId="other-fix"
			command={() => {}}
			onNavigate={() => {}}
		/>
	);
	assert.doesNotMatch(html, /data-pr-fix-id=/);
	h.setDetail({
		fix: { ...h.detail().fix, phase: "preparing", headSha: null, checks: [], changedFiles: [] },
		review: null,
	});
	await h.controller.ensureTarget("fix-1");
	html = renderToStaticMarkup(
		<PRFixView
			controller={ssrController(h.controller)}
			selectedId="fix-1"
			command={() => {}}
			onNavigate={() => {}}
		/>
	);
	assert.doesNotMatch(html, /data-pr-fix-id=/);
	assert.match(html, /data-pr-fix-status-id="fix-1"/);
	assert.match(html, /data-pr-fix-head="pending"/);
	assert.match(html, /data-pr-fix-path=""/);
	assert.match(html, /Checks not run/);
	assert.match(html, /worker has not produced a candidate commit/);
	assert.match(html, /disabled="">Mark fix reviewed/);
});

test("pending input, failure and interruption are explicit and original feedback is escaped", async () => {
	for (const phase of ["needs-input", "failed", "interrupted"] as const) {
		const h = harness();
		const detail = fixDetail();
		detail.fix.phase = phase;
		detail.fix.question = "Which behavior should empty input use?";
		detail.fix.error = phase === "failed" ? "Validation failed" : null;
		detail.fix.feedback.body = "<script>untrusted()</script>\nExact source";
		if (detail.review) detail.review.job.feedback = detail.fix.feedback;
		h.setDetail(detail);
		await h.controller.ensureTarget("fix-1");
		const html = renderToStaticMarkup(
			<PRFixView
				controller={ssrController(h.controller)}
				selectedId="fix-1"
				command={() => {}}
				onNavigate={() => {}}
			/>
		);
		assert.doesNotMatch(html, /<script>/);
		assert.match(html, /&lt;script&gt;/);
		assert.match(
			html,
			phase === "needs-input"
				? /Which behavior should empty input use/
				: phase === "failed"
					? /Validation failed/
					: /not been automatically restarted/
		);
		assert.match(html, /disabled="">Mark fix reviewed/);
	}
});

test("read-only diff and Before/Proposed after preserve exact pinned source and support bundled syntax tokens", async () => {
	const detail = fixDetail();
	assert.ok(detail.review);
	const first = detail.review.files[0];
	assert.ok(first);
	assert.deepEqual(diffLineCounts(first), { added: 2, removed: 1 });
	for (const view of ["base", "head"] as const) {
		const source: ReviewFile["head"] = first[view];
		const syntax = await highlightSource(source);
		assert.ok(syntax.lines.some((line) => line.some((token) => token.color)));
		const html = renderToStaticMarkup(
			<WorkDiff
				review={detail.review}
				command={() => {}}
				view={view}
				selectedPath={first.path}
				labels={{ base: "Before", head: "Proposed after" }}
				navigation
				showLineCounts
			/>
		);
		assert.match(html, new RegExp(`data-source-sha="${source.commitSha}"`));
		const renderedCode = /<pre aria-label="Source: [^"]*"><code>([\s\S]*?)<\/code><\/pre>/.exec(
			html
		)?.[1];
		assert.ok(renderedCode);
		const exactText = renderedCode
			.replace(/<button[\s\S]*?<\/button>/g, "")
			.replace(/<[^>]*>/g, "")
			.replaceAll("&lt;", "<")
			.replaceAll("&gt;", ">")
			.replaceAll("&amp;", "&");
		assert.equal(exactText, source.content);
		assert.match(html, /Before/);
		assert.match(html, /Proposed after/);
	}
});

test("file list selections emit encoded workspace targets and selected-file receipts match the actual source", async () => {
	const h = harness();
	const target = encodePRFixViewTarget({ id: "fix-1", path: "empty.test.ts" });
	await h.controller.ensureTarget(target);
	const controller = ssrController(h.controller);
	const detail = controller.store.getState().detail;
	assert.ok(detail);
	const loaded = detail;
	const selected: string[] = [];
	let controls: ReturnType<typeof buttons> = [];
	function Capture() {
		const element = PRFixReview({
			detail: loaded,
			controller,
			selectedPath: "empty.test.ts",
			onNavigate: (id) => selected.push(id),
			command() {},
		});
		controls = buttons(element);
		return element;
	}
	const html = renderToStaticMarkup(<Capture />);
	assert.match(html, /data-pr-fix-path="empty.test.ts"/);
	const firstFile = controls.find((button) => text(button.children).startsWith("src/main.ts"));
	assert.ok(firstFile?.onClick);
	firstFile.onClick();
	assert.deepEqual(selected, [encodePRFixViewTarget({ id: "fix-1", path: "src/main.ts" })]);
});

test("Prepare suggested fix works for non-code feedback and opens only the returned local fix", async () => {
	const h = harness();
	const feedback = h.detail().fix.feedback;
	assert.equal(feedback.suggestion, null);
	const html = renderToStaticMarkup(
		<PrepareSuggestedFixButton
			controller={ssrController(h.controller)}
			feedback={feedback}
			command={() => {}}
		/>
	);
	assert.match(html, /Prepare suggested fix/);
	const commands: WorkspaceCommand[] = [];
	await prepareSuggestedFix(h.controller, feedback, (command) => commands.push(command));
	assert.deepEqual(commands, [{ kind: "open-center", section: "fixes", selectedId: "new-fix-1" }]);
	assert.equal(
		h.calls.some((call) => call.path === "hub.operate"),
		false
	);
	const blank = renderToStaticMarkup(
		<PrepareSuggestedFixButton
			controller={ssrController(h.controller)}
			feedback={{ ...feedback, body: " " }}
			command={() => {}}
		/>
	);
	assert.equal(blank, "");
});

test("source-unavailable metadata has a status marker and cannot mark a fix reviewed", async () => {
	const h = harness();
	const detail = fixDetail();
	assert.ok(detail.review);
	const first = detail.review.files[0];
	assert.ok(first);
	first.patch = null;
	first.base.status = "binary";
	first.base.content = null;
	first.head.status = "binary";
	first.head.content = null;
	h.setDetail(detail);
	await h.controller.ensureTarget("fix-1");
	const html = renderToStaticMarkup(
		<PRFixView
			controller={ssrController(h.controller)}
			selectedId="fix-1"
			onNavigate={() => {}}
			command={() => {}}
		/>
	);
	assert.doesNotMatch(html, /data-pr-fix-id=/);
	assert.match(html, /data-pr-fix-status-id="fix-1"/);
	assert.match(html, /Diff unavailable/);
	assert.match(html, /disabled="">Mark fix reviewed/);
});

test("list shows only actual candidates, and optional CenterCanvas interception works without the hub", async () => {
	const h = harness();
	let html = renderToStaticMarkup(
		<PRFixList controller={ssrController(h.controller)} onSelect={() => {}} />
	);
	assert.doesNotMatch(html, /Handle empty input/);
	await h.controller.poll();
	await h.controller.ensureTarget("fix-1");
	html = renderToStaticMarkup(
		<PRFixList controller={ssrController(h.controller)} onSelect={() => {}} />
	);
	assert.match(html, /Handle empty input/);
	assert.match(html, /Ready to review/);
	html = renderToStaticMarkup(
		<CenterCanvas
			canvas={{
				id: "center-fixes",
				kind: "center",
				title: "Suggested fixes",
				revision: 1,
				section: "fixes",
				selectedId: "fix-1",
			}}
			fixes={ssrController(h.controller)}
			command={() => {}}
		/>
	);
	matching(html);
});

test("sidebar optional fixes rail and jobs use independent actual counts without requiring hub data", async () => {
	const call = async () => null;
	const hub = createHubController(call);
	hub.store.setState({
		snapshot: HubSnapshotSchema.parse({
			sequence: 0,
			refreshedAt: null,
			refreshing: false,
			viewer: { githubLogin: null, linearName: null },
			connections: { github: false, linear: false, model: false },
			repositories: [],
			reviews: [],
			tickets: [],
			jobs: [],
			notices: [],
			errors: [],
			preferences: { linearTeamIds: [], linearProjectIds: [], maxWorkers: 1 },
		}),
	});
	const reviews = createPreparedController(createPreparedApi(call), "test");
	const browser = createLocalBrowserController(call);
	const workspace = createWorkspaceController(call, reviews, browser, "test");
	workspace.store.setState({
		workspace: WorkspaceSnapshotSchema.parse({
			sequence: 0,
			primaryId: "fixes",
			secondaryId: null,
			centerSection: "fixes",
			review: { sequence: 0, mode: "conversation", prId: null },
			browser: null,
			canvases: [
				{
					id: "fixes",
					kind: "center",
					section: "fixes",
					title: "Fixes",
					revision: 1,
					selectedId: "fix-1",
				},
			],
		}),
	});
	const h = harness();
	await h.controller.poll();
	const props = {
		hub: { ...hub, store: { ...hub.store, getInitialState: hub.store.getState } },
		workspace: {
			...workspace,
			store: { ...workspace.store, getInitialState: workspace.store.getState },
		},
		conversationOpen: false,
		onConversation() {},
		onSettings() {},
	};
	const old = renderToStaticMarkup(<CommandSidebar {...props} />);
	assert.doesNotMatch(old, /title="Suggested fixes \(/);
	const current = renderToStaticMarkup(
		<CommandSidebar {...props} fixes={ssrController(h.controller)} />
	);
	assert.match(current, /aria-label="Suggested fixes \(1\)"/);
	assert.match(current, /Handle empty input/);
	workspace.dispose();
	reviews.dispose();
	browser.dispose();
	hub.dispose();
	h.controller.dispose();
});

test("refreshing exact detail removes rendered candidate acknowledgement until source settles", async () => {
	const pending = deferred<unknown>();
	let delayed = false;
	const h = harness((path) => (path === "prFixes.detail" && delayed ? pending.promise : undefined));
	await h.controller.ensureTarget("fix-1");
	delayed = true;
	const refresh = h.controller.ensureTarget("fix-1");
	const html = renderToStaticMarkup(
		<PRFixView
			controller={ssrController(h.controller)}
			selectedId="fix-1"
			command={() => {}}
			onNavigate={() => {}}
		/>
	);
	assert.doesNotMatch(html, /data-pr-fix-id=/);
	pending.resolve(h.detail());
	await refresh;
});
