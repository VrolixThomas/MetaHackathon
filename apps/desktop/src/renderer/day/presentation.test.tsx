import assert from "node:assert/strict";
import { it } from "node:test";
import { Children, type ReactNode, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	DayOperation,
	DaySnapshot,
	DayWorkItem as WorkItem,
} from "../../shared/contracts/day";
import type { WorkspaceCommand } from "../../shared/contracts/workspace";
import { DayQueue } from "./DayQueue";
import { DayReply } from "./DayReply";
import { DaySourceThread, type DayThreadState } from "./DaySourceThread";
import { DayWorkItem } from "./DayWorkItem";
import { createDayController } from "./controller";
import { phasePresentation } from "./model";
import { citation, message, snapshot, stamp, workItem } from "./test-support";

function supplied(items: WorkItem[] = [], overrides: Partial<DaySnapshot> = {}) {
	const value = snapshot(items, overrides);
	const controller = createDayController({
		snapshot: async () => value,
		operate: async () => {
			throw new Error("Unexpected action during render");
		},
	});
	controller.store.setState({ snapshot: value });
	return {
		...controller,
		store: { ...controller.store, getInitialState: controller.store.getState },
	};
}

type Button = { children?: ReactNode; onClick?(): void; disabled?: boolean };
function textOf(node: ReactNode): string {
	return Children.toArray(node)
		.map((child) =>
			isValidElement<{ children?: ReactNode }>(child)
				? textOf(child.props.children)
				: typeof child === "string" || typeof child === "number"
					? String(child)
					: ""
		)
		.join("");
}
/** Invoke the target under React's real SSR hook dispatcher, retaining its explicit controls. */
function controls(render: () => ReactNode) {
	const buttons: Button[] = [];
	function collect(node: ReactNode) {
		Children.forEach(node, (child) => {
			if (!isValidElement<Button>(child)) return;
			if (child.type === "button") buttons.push(child.props);
			collect(child.props.children);
		});
	}
	function Capture() {
		const node = render();
		collect(node);
		return node;
	}
	const html = renderToStaticMarkup(<Capture />);
	return {
		html,
		click(label: string) {
			const matches = buttons.filter((button) => textOf(button.children) === label);
			assert.equal(matches.length, 1, `Expected one action: ${label}`);
			const button = matches[0];
			assert.ok(button?.onClick);
			assert.ok(!button.disabled, `Action is disabled: ${label}`);
			button.onClick();
		},
	};
}

it("keeps startup, empty, failed and missing views honest without sample items", () => {
	const initial = createDayController({
		snapshot: async () => snapshot(),
		operate: async () => {
			throw new Error();
		},
	});
	const queue = (controller: typeof initial) =>
		renderToStaticMarkup(<DayQueue controller={controller} onOpenItem={() => {}} />);
	assert.match(queue(initial), /Loading your day/);
	assert.doesNotMatch(queue(initial), /Your day is clear|Controlled captured request/);
	const loaded = supplied();
	assert.match(queue(loaded), /Your day is clear/);
	loaded.store.setState({ snapshot: null, error: "Could not read" });
	assert.match(queue(loaded), /Your day could not be loaded.*Retry/s);
	assert.doesNotMatch(queue(loaded), /Your day is clear/);
	loaded.store.setState({ snapshot: snapshot([], { errors: ["source_unavailable"] }), error: "" });
	assert.match(queue(loaded), /Some day sources.*Refresh to check/s);
	assert.doesNotMatch(queue(loaded), /Your day is clear/);
	assert.match(
		renderToStaticMarkup(<DayWorkItem controller={loaded} itemId="retired" command={() => {}} />),
		/This work item is unavailable/
	);
	initial.dispose();
	loaded.dispose();
});

it("lists actual items only in the contextual queue and opens solely on explicit selection", () => {
	const controller = supplied([
		workItem(),
		workItem({ id: "second", title: "Other recorded item" }),
	]);
	const opens: string[] = [];
	const sidebar = controls(() =>
		DayQueue({ controller, selectedId: "item", onOpenItem: (id) => opens.push(id) })
	);
	assert.deepEqual(opens, []);
	assert.match(sidebar.html, /Acceptance pending.*Captured/s);
	assert.match(sidebar.html, /aria-current="true"/);
	assert.match(sidebar.html, /Private source · private channel/);
	assert.doesNotMatch(sidebar.html, /Workspace sections|browse-center|role="tab"|<nav/);
	sidebar.click(
		"Controlled captured requestAcceptance pending · CapturedPrivate source · private channel"
	);
	assert.deepEqual(opens, ["item"]);
	const detail = renderToStaticMarkup(
		<DayWorkItem controller={controller} itemId="item" command={() => {}} />
	);
	assert.doesNotMatch(detail, /Other recorded item|day-queue-list/);
	assert.match(sidebar.html, /<details class="day-capture">/);
	controller.dispose();
});

it("shows every durable phase, independent acceptance, inferred priority and actual checkpoint", () => {
	for (const phase of Object.keys(phasePresentation) as WorkItem["phase"][]) {
		const accepted = ["working", "ready_review", "awaiting_reply", "closed"].includes(phase);
		const source = citation();
		const row = workItem({
			phase,
			...(accepted
				? { acceptance: "accepted", acceptanceBasis: "user_action", acceptedAt: stamp }
				: {}),
			...(phase === "closed"
				? {
						answerReceipt: {
							requestId: "delivered",
							source: { ...source.source, messageId: "answer" },
							bodyDigest: "a".repeat(64),
							deliveredAt: stamp,
						},
					}
				: {}),
		});
		const controller = supplied([row]);
		const html = renderToStaticMarkup(
			<DayWorkItem controller={controller} itemId="item" command={() => {}} />
		);
		assert.ok(html.includes(phasePresentation[phase].label.replaceAll("&", "&amp;")), phase);
		assert.match(html, /Why this priority · inferred.*A source deadline needs attention/s);
		if (phase !== "cancelled") assert.match(html, /dateTime="2026-10-31T09:00:00.000Z"/);
		if (!accepted) assert.match(html, /Acceptance pending/);
		if (phase === "closed") assert.match(html, /Answer delivered/);
		assert.doesNotMatch(html, /All checks passed|Diff applied|Complete Linear|sample|demo/i);
		controller.dispose();
	}
});

it("distinguishes team, private and manual sources without broadening source access", () => {
	for (const [visibility, label] of [
		["public_channel", "Team source · public channel"],
		["private_channel", "Private source · private channel"],
		["direct_message", "Private source · direct message"],
		["group_direct_message", "Private source · group message"],
	] as const) {
		const controller = supplied([workItem({ source: citation(visibility) })]);
		const html = renderToStaticMarkup(
			<DayWorkItem controller={controller} itemId="item" command={() => {}} />
		);
		assert.ok(html.includes(label));
		assert.doesNotMatch(html, /readerIds|membershipRevision|Publish to team|Ask requester/);
		controller.dispose();
	}
	const manual = supplied([workItem({ source: null, requestedById: null })]);
	const html = renderToStaticMarkup(
		<DayWorkItem controller={manual} itemId="item" command={() => {}} />
	);
	assert.match(html, /Private to you · manual capture/);
	assert.doesNotMatch(html, /Open source in Slack/);
	manual.dispose();
});

it("reveals item Q&A only after explicit durable coverage and sends no random questions", async () => {
	const item = workItem({
		phase: "needs_context",
		questions: [
			{
				id: "question",
				question: "Which exact outcome should this cover?",
				answer: null,
				answeredAt: null,
			},
		],
	});
	const base = supplied([item]);
	const operations: DayOperation[] = [];
	const covering: string[] = [];
	const controller = {
		...base,
		operate: async (operation: DayOperation) => {
			operations.push(operation);
			const response = {
				requestId: "request",
				itemId: "item",
				snapshot: snapshot([item], { sequence: 2, currentItemId: "item" }),
			};
			base.store.setState({ snapshot: response.snapshot });
			return response;
		},
	};
	const props = {
		controller,
		itemId: "item",
		command() {},
		onCoverItem: (id: string) => covering.push(id),
	};
	const before = controls(() => DayWorkItem(props));
	assert.doesNotMatch(before.html, /Which exact outcome|<textarea|Your answer for Muse/);
	assert.deepEqual(operations, []);
	before.click("Cover this item with Muse");
	await Promise.resolve();
	assert.deepEqual(operations, [{ kind: "cover", itemId: "item", expectedRevision: 3 }]);
	assert.deepEqual(covering, ["item"]);
	controller.store.setState({ snapshot: snapshot([item], { sequence: 2, currentItemId: "item" }) });
	const covered = renderToStaticMarkup(<DayWorkItem {...props} />);
	assert.match(covered, /Which exact outcome/);
	assert.match(covered, /<details><summary>Type an answer<\/summary>/);
	assert.match(covered, /Your answer for Muse/);
	assert.doesNotMatch(covered, /Ask requester|Send question|<details open/);
	base.dispose();
});

it("opens real job and matched Linear links through workspace commands without fabricating review data", () => {
	const controller = supplied([
		workItem({
			phase: "ready_review",
			acceptance: "accepted",
			acceptanceBasis: "user_action",
			acceptedAt: stamp,
			jobId: "actual-job",
			linearIssueId: "actual-issue",
		}),
	]);
	const commands: WorkspaceCommand[] = [];
	const detail = controls(() =>
		DayWorkItem({
			controller,
			itemId: "item",
			command: (input) => commands.push(input),
			linear: {
				id: "actual-issue",
				identifier: "TEST-1",
				url: "https://linear.app/test/issue/TEST-1",
			},
		})
	);
	assert.deepEqual(commands, []);
	detail.click("Review recorded work");
	detail.click("Open TEST-1 in Linear ↗");
	assert.deepEqual(commands, [
		{ kind: "open-center", section: "activity", selectedId: "actual-job" },
		{ kind: "open-browser", url: "https://linear.app/test/issue/TEST-1" },
	]);
	assert.doesNotMatch(detail.html, /<pre|All checks|Complete ticket|Mark reviewed/);
	const mismatched = renderToStaticMarkup(
		<DayWorkItem
			controller={controller}
			itemId="item"
			command={() => {}}
			linear={{ id: "other", identifier: "WRONG-1", url: "https://linear.app/test/issue/WRONG-1" }}
		/>
	);
	assert.doesNotMatch(mismatched, /WRONG-1/);
	assert.match(mismatched, /Linked Linear issue · actual-issue/);
	controller.dispose();
});

it("renders exact escaped source text and rejects stale, cross-thread and cross-item payloads", () => {
	const item = workItem();
	const state: DayThreadState = {
		itemId: "item",
		expectedRevision: 3,
		loading: false,
		error: false,
		messages: [message()],
	};
	const render = (thread: DayThreadState) =>
		renderToStaticMarkup(<DaySourceThread item={item} thread={thread} command={() => {}} />);
	const html = render(state);
	assert.match(html, /Exact source\r\n\t&lt;script&gt;&amp; text/);
	assert.match(html, /data-source-message="original" data-source-revision="source-revision"/);
	assert.doesNotMatch(html, /<script>/);
	for (const thread of [
		{ ...state, itemId: "other" },
		{ ...state, expectedRevision: 2 },
		{ ...state, error: true },
		{
			...state,
			messages: [
				message("leak"),
				{
					...message("foreign leak"),
					citation: { ...citation(), source: { ...citation().source, threadId: "other-thread" } },
				},
			],
		},
	]) {
		assert.doesNotMatch(render(thread), /Exact source|foreign leak|>leak</);
	}
	assert.match(
		render({ ...state, messages: [{ ...message(""), deletedAt: stamp }] }),
		/Message deleted/
	);
	assert.match(
		render({ ...state, messages: [{ ...message(), truncated: true }] }),
		/Source text is truncated/
	);
});

it("requires an explicit exact-body reply action and keeps drafts distinct from delivered closure", async () => {
	const item = workItem({
		phase: "awaiting_reply",
		acceptance: "accepted",
		acceptanceBasis: "user_action",
		acceptedAt: stamp,
		replyDraft: { revision: 5, body: " Exact answer\n\twith spaces " },
	});
	const base = supplied([item]);
	const operations: DayOperation[] = [];
	const controller = {
		...base,
		operate: async (operation: DayOperation) => {
			operations.push(operation);
			return null;
		},
	};
	const reply = controls(() => DayReply({ item, controller, busy: false }));
	assert.deepEqual(operations, []);
	assert.match(reply.html, / Exact answer\n\twith spaces /);
	assert.doesNotMatch(reply.html, /Answer delivered|Closed/);
	reply.click("Send this exact reply to source");
	assert.deepEqual(operations, [
		{
			kind: "send_reply",
			itemId: "item",
			expectedRevision: 3,
			draftRevision: 5,
			body: item.replyDraft?.body,
		},
	]);
	const disabled = renderToStaticMarkup(
		<DayReply
			item={{ ...item, phase: "ready_review", jobId: "unreviewed-job", reviewedAt: null }}
			controller={controller}
			busy={false}
		/>
	);
	assert.match(disabled, /<button[^>]*disabled=""[^>]*>Send this exact reply/);
	base.dispose();
});
