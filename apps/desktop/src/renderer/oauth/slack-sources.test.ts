import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { SlackConnectionStatusSchema } from "../../shared/contracts/chat";
import type { ConversationApi } from "../conversation/api";
import { createOAuthController } from "./controller";
import { createSlackSourcesController } from "./slack-sources";
import { connected, deferred, status, statuses } from "./test-support";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
const source = (userId = "member", watching: string[] = []) =>
	SlackConnectionStatusSchema.parse({
		phase: "connected",
		account: {
			workspaceId: "workspace",
			workspaceName: "Controlled workspace",
			userId,
			userName: userId,
		},
		missing: [],
		coverage: "bounded-poll",
		watching,
		error: null,
	});
const conversation = (id: string) => ({
	workspaceId: "workspace",
	id,
	name: `Controlled ${id}`,
	visibility: "private_channel",
	canRead: true,
	canReply: true,
});
const page = (id = "channel", nextCursor: string | null = null) => ({
	items: [conversation(id)],
	nextCursor,
	hasMore: !!nextCursor,
});
function setup(call: ConversationApi["call"], authenticated = true) {
	const oauth = createOAuthController(async () => statuses());
	oauth.store.setState({
		rows: statuses(
			undefined,
			undefined,
			authenticated ? connected("slack", "member") : status("slack")
		),
	});
	let changes = 0;
	const sources = createSlackSourcesController(call, oauth, () => changes++);
	cleanups.push(() => {
		sources.dispose();
		oauth.dispose();
	});
	sources.start();
	return { oauth, sources, changes: () => changes };
}

it("source metadata cannot authenticate Slack or enable reading/watching without OAuth consent", async () => {
	const calls: string[] = [];
	const { sources } = setup(async (_type, path) => {
		calls.push(path);
		return source();
	}, false);
	await sources.refresh();
	assert.equal(sources.store.getState().status, null);
	await sources.load();
	await sources.action("slack.watch");
	assert.deepEqual(calls, ["slack.status"]);
});

it("watch selection preserves unsaved choices during polling and saves an exact deduplicated set", async () => {
	let watching: string[] = [];
	const calls: unknown[] = [];
	const { sources } = setup(async (_type, path, input) => {
		calls.push([path, input]);
		if (path === "slack.status") return source("member", watching);
		if (path === "slack.conversations") return page("channel", "next-page");
		watching = (input as { conversationIds: string[] }).conversationIds;
	});
	await sources.refresh();
	await sources.load();
	sources.select("channel", true);
	sources.select("channel", true);
	sources.select("unobserved", true);
	await sources.refresh();
	assert.deepEqual(sources.store.getState().selected, ["channel"]);
	await sources.action("slack.watch");
	assert.deepEqual(
		calls.find((row) => (row as unknown[])[0] === "slack.watch"),
		["slack.watch", { conversationIds: ["channel"] }]
	);
	assert.deepEqual(sources.store.getState().status?.watching, ["channel"]);
});

it("actual OAuth account changes clear choices/cursor/pending data and fence late pages and failures", async () => {
	for (const fail of [false, true]) {
		const oldPage = deferred<unknown>();
		let loads = 0;
		let current = "member";
		const { sources, oauth, changes } = setup(async (_type, path) =>
			path === "slack.status"
				? source(current)
				: ++loads === 1
					? page("old", "old-cursor")
					: oldPage.promise
		);
		await sources.refresh();
		await sources.load();
		sources.select("old", true);
		const pending = sources.load();
		current = "replacement";
		oauth.store.setState({ rows: statuses(undefined, undefined, connected("slack", current)) });
		assert.deepEqual(sources.store.getState().conversations, []);
		assert.deepEqual(sources.store.getState().selected, []);
		assert.equal(sources.store.getState().cursor, null);
		assert.equal(sources.store.getState().busy, false);
		assert.equal(changes(), 1);
		if (fail) oldPage.reject(new Error("old credential diagnostic"));
		else oldPage.resolve(page("late", "late-cursor"));
		await pending;
		await sources.refresh();
		assert.deepEqual(sources.store.getState().conversations, []);
		assert.equal(sources.store.getState().error, "");
		assert.equal(changes(), 1);
	}
});

it("pending login/cancel/disconnect hides source choices without claiming an account change", async () => {
	const { sources, oauth, changes } = setup(async (_type, path) =>
		path === "slack.status" ? source() : page()
	);
	await sources.refresh();
	await sources.load();
	for (const pending of ["connect", "cancel", "disconnect"] as const) {
		oauth.store.setState({ pending: { github: null, linear: null, slack: pending } });
		assert.equal(sources.store.getState().status, null);
		await sources.load();
		await sources.action("slack.watch");
		assert.deepEqual(sources.store.getState().conversations, []);
		assert.equal(changes(), 0);
	}
	oauth.store.setState({
		pending: { github: null, linear: null, slack: null },
		rows: statuses(undefined, undefined, status("slack")),
	});
	assert.equal(changes(), 1);
	await sources.refresh();
	assert.equal(sources.store.getState().status, null);
});

it("source account changes also clear pending choices and notify once, including workspace-only changes", async () => {
	let next = source();
	const oldPage = deferred<unknown>();
	const { sources, changes } = setup(async (_type, path) =>
		path === "slack.status" ? next : oldPage.promise
	);
	await sources.refresh();
	const loading = sources.load();
	const priorAccount = source().account;
	assert.ok(priorAccount);
	next = {
		...source("member", ["new-watch"]),
		account: { ...priorAccount, workspaceId: "new-workspace" },
	};
	await sources.refresh();
	await sources.refresh();
	oldPage.resolve(page("late"));
	await loading;
	assert.equal(changes(), 1);
	assert.deepEqual(sources.store.getState().conversations, []);
	assert.deepEqual(sources.store.getState().selected, ["new-watch"]);
});

it("status reads started before a watch mutation cannot restore old selection", async () => {
	const oldStatus = deferred<unknown>();
	let reads = 0;
	let watching: string[] = [];
	const { sources } = setup(async (_type, path, input) => {
		if (path === "slack.conversations") return page();
		if (path === "slack.watch") {
			watching = (input as { conversationIds: string[] }).conversationIds;
			return;
		}
		return ++reads === 2 ? oldStatus.promise : source("member", watching);
	});
	await sources.refresh();
	await sources.load();
	sources.select("channel", true);
	const poll = sources.refresh();
	await sources.action("slack.watch");
	oldStatus.resolve(source());
	await poll;
	assert.deepEqual(sources.store.getState().selected, ["channel"]);
	assert.deepEqual(sources.store.getState().status?.watching, ["channel"]);
});

it("failed auth actions fail closed for source reads even if source status still reports connected", async () => {
	const { sources, oauth } = setup(async (_type, path) =>
		path === "slack.status" ? source() : assert.fail("Source read allowed after auth failure")
	);
	await sources.refresh();
	oauth.store.setState({ errors: { github: null, linear: null, slack: "provider" } });
	await sources.refresh();
	assert.equal(sources.store.getState().status, null);
	await sources.load();
	await sources.action("slack.watch");
});

it("status failures release the read lock; malformed/foreign conversation pages never enter choices", async () => {
	let fail = true;
	const { sources } = setup((_type, path) => {
		if (fail) throw new Error("private token diagnostic");
		return Promise.resolve(
			path === "slack.status"
				? source()
				: { ...page(), items: [{ ...conversation("foreign"), workspaceId: "other" }] }
		);
	});
	await sources.refresh();
	assert.match(sources.store.getState().error, /unavailable/);
	fail = false;
	await sources.refresh();
	assert.equal(sources.store.getState().error, "");
	await sources.load();
	assert.deepEqual(sources.store.getState().conversations, []);
	assert.doesNotMatch(JSON.stringify(sources.store.getState()), /private token diagnostic|foreign/);
});

it("developer import is blocked during any provider login and cannot manufacture OAuth consent", async () => {
	const calls: string[] = [];
	const { sources, oauth } = setup(async (_type, path) => {
		calls.push(path);
		return source();
	}, false);
	await sources.refresh();
	oauth.store.setState({ pending: { github: "connect", linear: null, slack: null } });
	await sources.action("slack.connect");
	assert.deepEqual(calls, ["slack.status"]);
	oauth.store.setState({ pending: { github: null, linear: null, slack: null } });
	await sources.action("slack.connect");
	assert.ok(calls.includes("slack.connect"));
	assert.equal(sources.store.getState().status, null);
});

it("disposal retires late source work, subscriptions, selections and future IPC", async () => {
	const pending = deferred<unknown>();
	const calls: string[] = [];
	const { sources, oauth, changes } = setup(async (_type, path) => {
		calls.push(path);
		return path === "slack.status" ? source() : pending.promise;
	});
	await sources.refresh();
	const loading = sources.load();
	sources.dispose();
	const snapshot = sources.store.getState();
	oauth.store.setState({ rows: statuses(undefined, undefined, connected("slack", "replacement")) });
	pending.resolve(page());
	await loading;
	await sources.refresh();
	await sources.load();
	await sources.action("slack.connect");
	sources.select("channel", true);
	assert.equal(sources.store.getState(), snapshot);
	assert.equal(changes(), 0);
	assert.deepEqual(calls, ["slack.status", "slack.conversations"]);
});
