import assert from "node:assert/strict";
import { it } from "node:test";
import { Children, type ReactNode, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type WorkspaceCommand, WorkspaceSnapshotSchema } from "../../shared/contracts";
import { CommandSidebar } from "../command-center/Sidebar";
import { createHubController } from "../command-center/controller";
import { centerSections } from "../command-center/model";
import { OAuthProvider } from "../oauth/context";
import { createOAuthController } from "../oauth/controller";
import { createPreparedApi } from "../prepared/api";
import { createPreparedController } from "../prepared/controller";
import { createWorkspaceController } from "../workspace/controller";
import { createLocalBrowserController } from "../workspace/local-browser";
import { SlackConversationList, type SlackConversationListProps } from "./SlackConversationList";
import { SlackConversationView, type SlackConversationViewProps } from "./SlackConversationView";
import { slackPlainText } from "./presentation";
import { connected, conversation, deferred, harness, message, page, ssr } from "./test-support";

interface Controls {
	children?: ReactNode;
	"aria-label"?: string;
	onClick?(): void;
	onThread?(): void;
	onSelect?(id: string): void;
}
const text = (node: ReactNode): string =>
	Children.toArray(node)
		.map((child) =>
			isValidElement<{ children?: ReactNode }>(child)
				? text(child.props.children)
				: typeof child === "string" || typeof child === "number"
					? String(child)
					: ""
		)
		.join("");

/** Collect actual root callback closures using React's SSR hook dispatcher. */
function capture(render: () => ReactNode) {
	const controls: Controls[] = [];
	function collect(node: ReactNode) {
		Children.forEach(node, (child) => {
			if (!isValidElement<Controls>(child)) return;
			controls.push(child.props);
			collect(child.props.children);
		});
	}
	function Capture() {
		const element = render();
		collect(element);
		return element;
	}
	return { controls, html: renderToStaticMarkup(<Capture />) };
}

it("empty/loading/error/mismatched views never advertise a displayed Slack target or synthetic message", async () => {
	const { controller } = harness();
	const render = (selectedId?: string) =>
		renderToStaticMarkup(
			<SlackConversationView
				controller={ssr(controller)}
				selectedId={selectedId}
				onNavigate={() => {}}
			/>
		);
	assert.match(render(), /Select a channel or direct message/);
	assert.doesNotMatch(render(), /data-slack-target|Controlled message|textarea|contenteditable/);
	assert.match(render("C01"), /Loading conversation/);
	assert.doesNotMatch(render("C01"), /data-slack-target/);
	await controller.ensureTarget("C01");
	assert.doesNotMatch(render("C02"), /data-slack-target|Controlled message/);
	await assert.rejects(controller.ensureTarget("invalid"));
	assert.match(render("invalid"), /Conversation unavailable/);
	assert.doesNotMatch(render("invalid"), /data-slack-target/);
	controller.dispose();
});

it("shows returned authors, exact ISO timestamps, ID fallback, safe plain text, deletion and truncation honestly", async () => {
	const safePage = page();
	safePage.items = [
		{
			...message(),
			text: "<script>alert(1)</script> &amp; <@U02> <@U99> <https://example.com|Docs> &lt;img src=x&gt;\n*literal markup*",
			truncated: true,
		},
		{ ...message("1000000000.000002"), authorId: "U99", text: "Fallback author" },
		{ ...message("1000000000.000003"), text: "", deletedAt: "2026-10-31T11:01:00.000Z" },
		{ ...message("1000000000.000004"), text: "" },
	];
	safePage.authors = [{ id: "U02", name: "Actual <img> label" }];
	const { controller } = harness(async (_, path) =>
		path === "slack.history" ? safePage : undefined
	);
	await controller.ensureTarget("C01");
	const html = renderToStaticMarkup(
		<SlackConversationView controller={ssr(controller)} selectedId="C01" onNavigate={() => {}} />
	);
	assert.match(html, /data-slack-target="C01"/);
	assert.match(html, /Actual &lt;img&gt; label/);
	assert.match(html, /<strong title="U99">U99<\/strong>/);
	assert.match(html, /dateTime="2026-10-31T11:00:00.000Z"/i);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(html, /@Actual &lt;img&gt; label @U99 Docs \(https:\/\/example.com\)/);
	assert.match(html, /\*literal markup\*/);
	assert.match(html, /Message deleted/);
	assert.match(html, /truncated at the source/);
	assert.match(html, /No plain text was returned/);
	assert.doesNotMatch(
		html,
		/<script|<img|href=|textarea|contenteditable|Post message|Send message/
	);
	controller.dispose();
});

it("thread and back navigation emit canonical target IDs only, leaving controller selection to root", async () => {
	const { controller } = harness();
	const navigations: string[] = [];
	const props: SlackConversationViewProps = {
		controller: ssr(controller),
		selectedId: "C01",
		onNavigate: (target) => navigations.push(target),
	};
	await controller.ensureTarget("C01");
	props.controller = ssr(controller);
	const main = capture(() => SlackConversationView(props));
	const threadControl = main.controls.find((control) => control.onThread)?.onThread;
	assert.ok(threadControl);
	threadControl();
	assert.deepEqual(navigations, ["C01/1000000000.000001"]);
	assert.equal(controller.store.getState().loadedTarget, "C01");
	await controller.ensureTarget(navigations[0] ?? "");
	const thread = capture(() =>
		SlackConversationView({ ...props, controller: ssr(controller), selectedId: navigations[0] })
	);
	assert.match(thread.html, /data-slack-target="C01\/1000000000.000001"/);
	assert.match(thread.html, /Slack thread/);
	assert.doesNotMatch(thread.html, /View thread/);
	const back = thread.controls.find(
		(control) => text(control.children).includes("Back to conversation") && control.onClick
	)?.onClick;
	assert.ok(back);
	back();
	assert.equal(navigations.at(-1), "C01");
	assert.equal(controller.store.getState().loadedTarget, "C01/1000000000.000001");
	controller.dispose();
});

it("keeps empty returned pages displayable without pretending they are loading or a complete history", async () => {
	const { controller } = harness(async (_, path) =>
		path === "slack.history"
			? { ...page(), items: [], authors: [], hasMore: true, nextCursor: "older" }
			: undefined
	);
	await controller.ensureTarget("C01");
	const html = renderToStaticMarkup(
		<SlackConversationView controller={ssr(controller)} selectedId="C01" onNavigate={() => {}} />
	);
	assert.match(html, /data-slack-target="C01"/);
	assert.match(html, /No messages returned/);
	assert.match(html, /Load older messages/);
	assert.match(html, /More available/);
	assert.doesNotMatch(html, /Loading conversation|No messages ever|All messages/);
	controller.dispose();
});

it("clears the exact DOM display marker while a refresh is still pending", async () => {
	let refresh = false;
	const wait = deferred<ReturnType<typeof page>>();
	const { controller } = harness(async (_, path) =>
		path === "slack.history" && refresh ? wait.promise : undefined
	);
	await controller.ensureTarget("C01");
	refresh = true;
	const operation = controller.refreshCurrent();
	const html = renderToStaticMarkup(
		<SlackConversationView controller={ssr(controller)} selectedId="C01" onNavigate={() => {}} />
	);
	assert.doesNotMatch(html, /data-slack-target|Controlled message/);
	assert.match(html, /Loading conversation/);
	wait.resolve(page());
	await operation;
	controller.dispose();
});

it("separates actual channel/DM metadata, keeps thread conversation selected and emits root-only selections", async () => {
	const { controller, calls } = harness(async (_, path) =>
		path === "slack.conversations"
			? {
					items: [
						conversation(),
						{ ...conversation("C02"), name: "Private source", visibility: "private_channel" },
						{ ...conversation("D01"), name: "Actual teammate", visibility: "direct_message" },
						{
							...conversation("G01"),
							name: "Actual group",
							visibility: "group_direct_message",
							canRead: false,
						},
					],
					nextCursor: "catalog-2",
					hasMore: true,
				}
			: undefined
	);
	await controller.start();
	const selected: string[] = [];
	const props: SlackConversationListProps = {
		controller: ssr(controller),
		selectedId: "D01/1000000000.000001",
		onSelect: (id) => selected.push(id),
	};
	const { html, controls } = capture(() => SlackConversationList(props));
	assert.match(html, /aria-label="Channels"/);
	assert.match(html, /aria-label="Direct messages"/);
	assert.match(html, /Actual teammate/);
	assert.match(html, /Private source · Private channel/);
	assert.match(html, /aria-current="true"[^>]*title="Actual teammate/);
	assert.match(html, /disabled=""[^>]*title="Actual group/);
	assert.match(html, /Search covers 4 loaded conversations/);
	const before = calls.length;
	const choose = controls.find(
		(control) => text(control.children).includes("Actual teammate") && control.onClick
	)?.onClick;
	assert.ok(choose);
	choose();
	assert.deepEqual(selected, ["D01"]);
	assert.equal(calls.length, before);
	assert.equal(controller.store.getState().loadedTarget, null);
	assert.doesNotMatch(html, /unread|online|Latest message|composer|textarea/);
	controller.dispose();
});

it("renders source-wide failures as errors and keeps the source target unacknowledgeable", async () => {
	const { controller } = harness(async (_, path) =>
		path === "slack.status"
			? { ...connected(), phase: "error", error: "authentication" }
			: undefined
	);
	await assert.rejects(controller.ensureTarget("C01"));
	const html = renderToStaticMarkup(
		<SlackConversationView controller={ssr(controller)} selectedId="C01" onNavigate={() => {}} />
	);
	assert.match(html, /Connect Slack in Settings/);
	assert.match(html, /Retry conversation/);
	assert.doesNotMatch(html, /data-slack-target|Loading conversation/);
	controller.dispose();
});

it("decodes only supported Slack tokens into inert text, without recursive entity interpretation", () => {
	assert.equal(
		slackPlainText(
			"&amp;lt;script&amp;gt; <@U02> <@U99> <!here> <#C01|name> <javascript:alert(1)|click> <unsupported>",
			{ U02: "Actual name" }
		),
		"&lt;script&gt; @Actual name @U99 @here #name <javascript:alert(1)|click> <unsupported>"
	);
});

it("Sidebar reads independent Slack state without Hub data and routes the exact thread identity through workspace.command", async () => {
	const { controller } = harness();
	await controller.start();
	const hub = createHubController(async () => {
		throw new Error("No provider calls");
	});
	const call = async () => null;
	const reviews = createPreparedController(createPreparedApi(call), "controlled-session");
	const browser = createLocalBrowserController(call);
	const workspace = createWorkspaceController(call, reviews, browser, "controlled-session");
	workspace.store.setState({
		workspace: WorkspaceSnapshotSchema.parse({
			sequence: 1,
			centerSection: "slack",
			primaryId: "slack-canvas",
			secondaryId: null,
			review: { sequence: 0, mode: "conversation", prId: null },
			browser: null,
			canvases: [
				{
					id: "slack-canvas",
					kind: "center",
					section: "slack",
					selectedId: "C01/1000000000.000001",
					title: "Slack",
					revision: 1,
				},
			],
		}),
	});
	const commands: WorkspaceCommand[] = [];
	const props = {
		hub,
		slack: ssr(controller),
		workspace: {
			...workspace,
			store: { ...workspace.store, getInitialState: workspace.store.getState },
			command: async (command: WorkspaceCommand) => {
				commands.push(command);
				return "applied" as const;
			},
		},
		conversationOpen: false,
		onConversation() {},
		onSettings() {},
	};
	// Root owns this definition. Supply its agreed metadata only until root's integration commit lands.
	const insertDefinition = !centerSections.some((item) => item.id === "slack");
	if (insertDefinition) centerSections.push({ id: "slack", label: "Slack" });
	try {
		const sidebar = capture(() => CommandSidebar(props));
		assert.match(sidebar.html, /Controlled C01/);
		assert.doesNotMatch(sidebar.html, /Loading your workspace/);
		assert.match(sidebar.html, /aria-label="Slack \(1\)"/);
		const select = sidebar.controls.find((control) => control.onSelect)?.onSelect;
		assert.ok(select);
		select("C01/1000000000.000001");
		assert.deepEqual(commands.pop(), {
			kind: "open-center",
			section: "slack",
			selectedId: "C01/1000000000.000001",
		});
		const absent = renderToStaticMarkup(<CommandSidebar {...props} slack={undefined} />);
		assert.doesNotMatch(absent, /aria-label="Slack(?: \(|")/);
	} finally {
		if (insertDefinition) centerSections.pop();
		controller.dispose();
		hub.dispose();
		workspace.dispose();
	}
});

it("disconnected Slack offers inline sign-in without opening Settings", () => {
	const h = harness();
	const oauth = createOAuthController(async () => {
		throw new Error("Rendering must not start login");
	});
	const html = renderToStaticMarkup(
		<OAuthProvider controller={oauth}>
			<SlackConversationList controller={ssr(h.controller)} onSelect={() => {}} />
		</OAuthProvider>
	);
	assert.match(html, />Connect Slack<\/button>/);
	assert.doesNotMatch(html, /Connect Slack in Settings/);
	oauth.dispose();
	h.controller.dispose();
});
