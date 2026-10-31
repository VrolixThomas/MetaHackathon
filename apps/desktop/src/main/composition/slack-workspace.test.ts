import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatSource } from "../../shared/contracts/chat";
import type { DayActor } from "../../shared/contracts/day";
import { type DayState, parseDayState } from "../day/model";
import { type DayReplyPort, DayService } from "../day/service";
import {
	type SlackIdentity,
	SlackIdentitySchema,
	type SlackLease,
	type SlackPreferences,
	SlackPreferencesSchema,
	type SlackSourceRecord,
	SlackSourceRecordSchema,
	SlackStoreError,
	type SlackWorkspaceStorePort,
	emptySlackPreferences,
	slackSourceKey,
} from "../db/slack-store";
import type { SlackCheckpoint } from "../slack/intake";
import { SLACK_USER_SCOPES } from "../slack/oauth";
import type { SlackSocket } from "../slack/socket";
import type { SlackCredential } from "../slack/types";
import { SlackWorkspaceCoordinator, type SlackWorkspaceOptions } from "./slack-workspace";

const initialNow = Date.parse("2026-10-31T00:00:00.000Z");
const ts = (offset = 0) => `${Math.floor(initialNow / 1000) + offset}.000001`;
const credential: SlackCredential = {
	connectionId: "connection-one",
	workspaceId: "T111",
	userId: "U111",
	appId: "A111",
	tokenKind: "user",
	accessToken: "controlled-private-token",
	scopes: [...SLACK_USER_SCOPES],
};
const identity = (value: SlackLease | SlackCredential) =>
	SlackIdentitySchema.parse({
		connectionId: value.connectionId,
		workspaceId: value.workspaceId,
		userId: value.userId,
		appId: value.appId,
	});
const candidate = {
	kind: "request",
	title: "Controlled requested work",
	summary: "Inferred from the controlled source",
	repositoryId: null,
};
const raw = (text = "Please investigate this source", extra = {}) => ({
	ts: ts(),
	user: "U222",
	text,
	...extra,
});
class MemorySlackStore implements SlackWorkspaceStorePort {
	active: { epoch: number; identity: SlackIdentity | null } = { epoch: 0, identity: null };
	readonly checkpoints = new Map<string, { sequence: number; data: SlackCheckpoint }>();
	readonly prefs = new Map<string, SlackPreferences>();
	readonly sources = new Map<string, SlackSourceRecord>();
	failApplied = false;
	private key(lease: SlackLease) {
		return `${lease.workspaceId}:${lease.userId}`;
	}
	private check(lease: SlackLease) {
		if (
			this.active.epoch !== lease.epoch ||
			JSON.stringify(this.active.identity) !== JSON.stringify(identity(lease))
		)
			throw new SlackStoreError("conflict");
	}
	async head() {
		return structuredClone(this.active);
	}
	async activate(value: SlackIdentity, expected: number) {
		assert.equal(this.active.epoch, expected);
		this.active = { epoch: expected + 1, identity: structuredClone(value) };
		return { ...value, epoch: expected + 1 };
	}
	async release(lease: SlackLease) {
		this.check(lease);
		this.active = { epoch: lease.epoch + 1, identity: null };
	}
	async checkpoint(lease: SlackLease) {
		this.check(lease);
		return structuredClone(this.checkpoints.get(lease.connectionId) ?? null);
	}
	async saveCheckpoint(lease: SlackLease, data: SlackCheckpoint, expected: number) {
		this.check(lease);
		assert.equal(this.checkpoints.get(lease.connectionId)?.sequence ?? 0, expected);
		this.checkpoints.set(lease.connectionId, {
			sequence: expected + 1,
			data: structuredClone(data),
		});
	}
	async preferences(lease: SlackLease) {
		this.check(lease);
		return structuredClone(this.prefs.get(this.key(lease)) ?? emptySlackPreferences());
	}
	async savePreferences(lease: SlackLease, value: SlackPreferences, expected: number) {
		this.check(lease);
		assert.equal(this.prefs.get(this.key(lease))?.sequence ?? 0, expected);
		assert.equal(value.sequence, expected + 1);
		this.prefs.set(this.key(lease), SlackPreferencesSchema.parse(value));
	}
	async source(lease: SlackLease, source: ChatSource) {
		this.check(lease);
		return structuredClone(
			this.sources.get(`${this.key(lease)}:${slackSourceKey(source)}`) ?? null
		);
	}
	async saveSource(lease: SlackLease, value: SlackSourceRecord, expected: number) {
		this.check(lease);
		const key = `${this.key(lease)}:${slackSourceKey(value.source)}`;
		assert.equal(this.sources.get(key)?.sequence ?? 0, expected);
		assert.equal(value.sequence, expected + 1);
		if (this.failApplied && value.dayApplied) {
			this.failApplied = false;
			throw new SlackStoreError();
		}
		this.sources.set(key, SlackSourceRecordSchema.parse(value));
	}
	async pending(lease: SlackLease, limit: number, conversations?: readonly string[]) {
		this.check(lease);
		return structuredClone(
			[...this.sources.entries()]
				.filter(
					([key, row]) =>
						key.startsWith(`${this.key(lease)}:`) &&
						(!row.dayApplied || !row.knowledgeApplied) &&
						(!conversations || conversations.includes(row.source.conversationId))
				)
				.map(([, row]) => row)
				.slice(0, limit)
		);
	}
}
class MemoryDayStore {
	state: DayState | null = null;
	async loadState() {
		return structuredClone(this.state);
	}
	async saveState(state: DayState, expected: number) {
		assert.equal(this.state?.sequence ?? 0, expected);
		this.state = parseDayState(structuredClone(state));
	}
}
class FakeSocket implements SlackSocket {
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	sent: string[] = [];
	send(data: string) {
		this.sent.push(data);
	}
	close() {}
	emit(event: unknown, id = "Ev1", envelope = "envelope") {
		this.onmessage?.({
			data: JSON.stringify({
				type: "events_api",
				envelope_id: envelope,
				payload: {
					type: "event_callback",
					api_app_id: "A111",
					team_id: "T111",
					event_id: id,
					authorizations: [{ team_id: "T111", user_id: "U111", is_bot: false }],
					event,
				},
			}),
		});
	}
}
async function until(ready: () => boolean) {
	for (let i = 0; i < 1000; i++) {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.ok(ready(), "controlled coordinator condition did not settle");
}
function harness(overrides: Partial<SlackWorkspaceOptions> = {}, store = new MemorySlackStore()) {
	const control = {
		credential: credential as SlackCredential | undefined,
		now: initialNow,
		availability: { awake: true, online: true },
		rateLimited: false,
		classifyCalls: 0,
	};
	const calls: { method: string; fields: Record<string, unknown> }[] = [];
	const messages = new Map<string, ReturnType<typeof raw>[]>([
		["D111", [raw()]],
		["D222", [raw("Second conversation", { ts: ts(1) })]],
	]);
	const days = new Map<string, { day: DayService; store: MemoryDayStore }>();
	const activations: DayActor[] = [];
	let currentDay: DayService | undefined;
	let replies: DayReplyPort | undefined;
	const options: SlackWorkspaceOptions = {
		store,
		getCredential: async () => control.credential,
		getDay: () => currentDay,
		activateActor: async (actor, port) => {
			activations.push(actor);
			replies = port;
			const key = `${actor.workspaceId}:${actor.userId}`;
			let entry = days.get(key);
			if (!entry) {
				const dayStore = new MemoryDayStore();
				const day = new DayService({
					actor,
					store: dayStore,
					availability: () => control.availability,
					replies: port,
					now: () => control.now,
				});
				entry = { day, store: dayStore };
				days.set(key, entry);
			}
			currentDay = entry.day;
			await currentDay.initialize();
		},
		availability: () => control.availability,
		now: () => control.now,
		cadenceMs: 100000,
		classify: async () => {
			control.classifyCalls++;
			assert.ok(currentDay, "actor must be activated before classification");
			return candidate;
		},
		clientOptions: {
			historyIntervalMs: 0,
			fetch: (async (input, init) => {
				const url = new URL(String(input));
				assert.equal(url.origin, "https://slack.com");
				assert.equal(init?.redirect, "error");
				const fields = JSON.parse(String(init?.body)) as Record<string, unknown>;
				const method = url.pathname.replace("/api/", "");
				calls.push({ method, fields });
				if (method === "auth.test")
					return Response.json({
						ok: true,
						team_id: control.credential?.workspaceId,
						user_id: control.credential?.userId,
					});
				if (method === "apps.connections.open")
					return Response.json({
						ok: true,
						url: "wss://wss-primary.slack.com/link?ticket=controlled",
					});
				if (method === "users.conversations")
					return Response.json({
						ok: true,
						channels: [{ id: "D111", is_im: true }],
						response_metadata: { next_cursor: "cursor-two" },
					});
				if (method === "conversations.info")
					return Response.json({
						ok: true,
						channel: { id: fields["channel"], is_im: true, is_private: true },
					});
				if (method === "conversations.members")
					return Response.json({ ok: true, members: [control.credential?.userId, "U222"] });
				if (method === "conversations.history")
					return control.rateLimited
						? new Response("provider-private", { status: 429, headers: { "retry-after": "120" } })
						: Response.json({ ok: true, messages: messages.get(String(fields["channel"])) ?? [] });
				if (method === "conversations.replies")
					return Response.json({
						ok: true,
						messages:
							messages
								.get(String(fields["channel"]))
								?.map((message) => ({ ...message, thread_ts: fields["ts"] })) ?? [],
					});
				if (method === "chat.postMessage")
					return Response.json({
						ok: true,
						channel: fields["channel"],
						ts: ts(100),
						message: {
							text: fields["text"],
							user: control.credential?.userId,
							thread_ts: fields["thread_ts"],
						},
					});
				throw new Error("unexpected controlled provider operation");
			}) as typeof fetch,
		},
		...overrides,
	};
	return {
		coordinator: new SlackWorkspaceCoordinator(options),
		options,
		control,
		calls,
		messages,
		store,
		days,
		activations,
		day: () => {
			assert.ok(currentDay);
			return currentDay;
		},
		replies: () => {
			assert.ok(replies);
			return replies;
		},
	};
}

test("empty watch has no automatic conversation/history/socket crawl; read proxy uses actual cursor", async () => {
	const h = harness({ getAppToken: async () => "xapp-controlled" });
	try {
		await h.coordinator.start();
		assert.equal(h.coordinator.status().mode, "idle");
		assert.deepEqual(
			h.calls.map((call) => call.method),
			["auth.test"]
		);
		const page = await h.coordinator.conversations({ cursor: "explicit-page", limit: 15 });
		assert.equal(page.items[0]?.id, "D111");
		assert.equal(page.nextCursor, "cursor-two");
		assert.equal(h.calls.at(-1)?.fields["cursor"], "explicit-page");
		assert.equal(h.control.classifyCalls, 0);
	} finally {
		await h.coordinator.dispose();
	}
});

test("real source becomes private pending Day work after actor activation and cached classification; context waits for review", async () => {
	const h = harness({
		initialWatches: ["D111"],
		classify: async () => ({
			...candidate,
			questions: ["Which deadline?"],
			priorityRank: 2,
			priorityReason: "Inferred urgency",
			explicitOwnPromise: true,
		}),
	});
	try {
		await h.coordinator.start();
		const snapshot = await h.day().snapshot();
		const item = snapshot.items[0];
		assert.ok(item);
		assert.deepEqual(h.activations, [{ workspaceId: "T111", userId: "U111" }]);
		assert.equal(item.source?.source.messageId, ts());
		assert.equal(item.source?.audience.visibility, "direct_message");
		assert.equal(item.acceptance, "pending");
		assert.equal(item.questions[0]?.question, "Which deadline?");
		assert.equal(snapshot.currentItemId, null);
		assert.equal(h.calls.filter((c) => c.method === "chat.postMessage").length, 0);
		const row = [...h.store.sources.values()][0];
		assert.ok(row?.decision && row.decision.kind !== "none");
		assert.equal(row.decision.priorityRank, 2);
		assert.ok(!JSON.stringify(h.coordinator.status()).includes(credential.accessToken));
		assert.ok(!JSON.stringify([...h.store.sources.values()]).includes(credential.accessToken));
	} finally {
		await h.coordinator.dispose();
	}
});

test("none decision and completed decision survive restart without another classification or history flood", async () => {
	const h = harness({
		initialWatches: ["D111"],
		classify: async () => {
			h.control.classifyCalls++;
			return null;
		},
	});
	let resumed: SlackWorkspaceCoordinator | undefined;
	try {
		await h.coordinator.start();
		assert.equal(h.control.classifyCalls, 1);
		assert.equal((await h.day().snapshot()).items.length, 0);
		await h.coordinator.stop();
		resumed = new SlackWorkspaceCoordinator(h.options);
		await resumed.start();
		assert.equal(h.control.classifyCalls, 1);
		assert.equal(h.calls.filter((c) => c.method === "conversations.history").length, 1);
		assert.deepEqual([...h.store.sources.values()][0]?.decision, { kind: "none" });
	} finally {
		await h.coordinator.dispose();
		await resumed?.dispose();
	}
});

test("classification cache is committed before capture replay when Day-applied checkpoint fails", async () => {
	const h = harness({ initialWatches: ["D111"] });
	try {
		h.store.failApplied = true;
		await h.coordinator.start();
		assert.equal(h.control.classifyCalls, 1);
		assert.equal((await h.day().snapshot()).items.length, 1);
		await h.coordinator.tick();
		assert.equal(h.control.classifyCalls, 1);
		assert.equal((await h.day().snapshot()).items.length, 1);
		assert.equal([...h.store.sources.values()][0]?.dayApplied, true);
	} finally {
		await h.coordinator.dispose();
	}
});

test("edit reclassified as none cancels existing active work and cannot replay the old candidate", async () => {
	let classification: unknown = candidate;
	const h = harness({ initialWatches: ["D111"], classify: async () => classification });
	try {
		await h.coordinator.start();
		const item = (await h.day().snapshot()).items[0];
		assert.ok(item);
		await h.day().operate({
			requestId: "accept",
			operation: { kind: "accept", itemId: item.id, expectedRevision: item.revision },
		});
		classification = null;
		h.messages.set("D111", [raw("No current commitment", { edited: { ts: ts(2) } })]);
		h.control.now += 1000;
		await h.coordinator.tick();
		assert.equal((await h.day().snapshot()).items[0]?.phase, "cancelled");
		assert.equal([...h.store.sources.values()][0]?.source.revisionId, ts(2));
		assert.deepEqual([...h.store.sources.values()][0]?.decision, { kind: "none" });
	} finally {
		await h.coordinator.dispose();
	}
});

test("model promise flags alone never autoaccept; trusted authority requires the actual own author", async () => {
	const h = harness({
		initialWatches: ["D111"],
		classify: async () => ({ ...candidate, kind: "promise", explicitOwnPromise: true }),
	});
	const own = harness({
		initialWatches: ["D111"],
		classify: async () => ({ ...candidate, kind: "promise" }),
		ownPromiseAuthority: ({ actor }) => ({ explicitOwnPromise: true, actor }),
	});
	try {
		await h.coordinator.start();
		assert.equal((await h.day().snapshot()).items[0]?.acceptance, "pending");
		await own.coordinator.start();
		assert.equal((await own.day().snapshot()).items.length, 0);
		assert.equal(own.coordinator.status().error, "access-denied");
	} finally {
		await h.coordinator.dispose();
		await own.coordinator.dispose();
	}
});

test("source-bound trusted own promise autoaccepts only its actual author", async () => {
	const h = harness({
		initialWatches: ["D111"],
		classify: async () => ({ ...candidate, kind: "promise" }),
		ownPromiseAuthority: ({ actor }) => ({ explicitOwnPromise: true, actor }),
	});
	h.messages.set("D111", [raw("I will investigate", { user: "U111" })]);
	try {
		await h.coordinator.start();
		assert.equal((await h.day().snapshot()).items[0]?.acceptanceBasis, "own_explicit_promise");
	} finally {
		await h.coordinator.dispose();
	}
});

test("fair watched streams and known threads use one bounded history/reply page per cycle", async () => {
	const h = harness({ initialWatches: ["D111", "D222"] });
	h.messages.set("D111", [raw("Thread parent", { reply_count: 1 })]);
	try {
		await h.coordinator.start();
		h.control.now += 1000;
		await h.coordinator.tick();
		h.control.now += 1000;
		await h.coordinator.tick();
		assert.deepEqual(
			h.calls.filter((c) => c.method === "conversations.history").map((c) => c.fields["channel"]),
			["D111", "D222"]
		);
		assert.equal(h.calls.filter((c) => c.method === "conversations.replies").length, 1);
		assert.ok(
			h.calls
				.filter((c) => ["conversations.history", "conversations.replies"].includes(c.method))
				.every((c) => c.fields["limit"] === 15)
		);
	} finally {
		await h.coordinator.dispose();
	}
});

test("Retry-After and per-method budget persist across repeated cycles and restart", async () => {
	const h = harness({ initialWatches: ["D111"] });
	h.control.rateLimited = true;
	let resumed: SlackWorkspaceCoordinator | undefined;
	try {
		await h.coordinator.start();
		assert.equal(h.coordinator.status().error, "rate-limited");
		const deadline = h.coordinator.status().retryAt;
		await h.coordinator.tick();
		assert.equal(h.coordinator.status().retryAt, deadline);
		await h.coordinator.stop();
		resumed = new SlackWorkspaceCoordinator(h.options);
		await resumed.start();
		assert.equal(resumed.status().retryAt, deadline);
		assert.equal(h.calls.filter((c) => c.method === "conversations.history").length, 1);
		h.control.now += 120000;
		await resumed.tick();
		assert.equal(h.calls.filter((c) => c.method === "conversations.history").length, 2);
	} finally {
		await h.coordinator.dispose();
		await resumed?.dispose();
	}
});

test("sleep/offline abort work without a window and reconnects only while available", async () => {
	const h = harness({ initialWatches: ["D111"] });
	try {
		await h.coordinator.start();
		const count = h.calls.length;
		h.control.availability = { awake: false, online: false };
		await h.coordinator.availabilityChanged();
		await h.coordinator.tick();
		assert.equal(h.coordinator.status().mode, "sleeping");
		assert.equal(h.calls.length, count);
		h.control.availability = { awake: true, online: false };
		await h.coordinator.availabilityChanged();
		assert.equal(h.coordinator.status().mode, "offline");
		h.control.availability = { awake: true, online: true };
		await h.coordinator.availabilityChanged();
		assert.equal(h.coordinator.status().actor?.userId, "U111");
	} finally {
		await h.coordinator.dispose();
	}
});

test("new account activates its own Day before any sources, with no inherited private watches", async () => {
	const h = harness({ initialWatches: ["D111"] });
	try {
		await h.coordinator.start();
		h.control.credential = { ...credential, connectionId: "connection-two", userId: "U333" };
		// Explicit root defaults are per account, so disable that opt-in for this replacement.
		h.options.initialWatches = [];
		await h.coordinator.tick();
		assert.equal(h.coordinator.status().actor?.userId, "U333");
		assert.equal(h.coordinator.status().watchCount, 0);
		assert.equal((await h.day().snapshot()).items.length, 0);
		assert.equal(h.activations.length, 2);
	} finally {
		await h.coordinator.dispose();
	}
});

test("unknown deletion persists only metadata, calls root invalidation and never invents a Day message", async () => {
	const socket = new FakeSocket();
	const invalidations: { source: ChatSource; deleted?: boolean }[] = [];
	const h = harness({
		initialWatches: ["D111"],
		getAppToken: async () => "xapp-controlled",
		socketConnect: () => socket,
		invalidateSource: async (input) => {
			invalidations.push(input);
		},
	});
	h.messages.set("D111", []);
	try {
		await h.coordinator.start();
		await until(() => !!socket.onmessage);
		socket.onopen?.();
		socket.emit({
			type: "message",
			channel: "D111",
			subtype: "message_deleted",
			deleted_ts: ts(7),
			event_ts: ts(8),
		});
		await until(() => socket.sent.length === 1);
		await h.coordinator.tick();
		const row = [...h.store.sources.values()][0];
		assert.equal(row?.deleted, true);
		assert.equal(row?.message, null);
		assert.equal((await h.day().snapshot()).items.length, 0);
		assert.equal(invalidations[0]?.source.messageId, ts(7));
		assert.equal(invalidations[0]?.deleted, true);
		assert.equal(h.control.classifyCalls, 0);
	} finally {
		await h.coordinator.dispose();
	}
});

test("new source revision arriving during classification fences the late old candidate before capture", async () => {
	const socket = new FakeSocket();
	let release: ((value: unknown) => void) | undefined;
	let attempts = 0;
	const h = harness({
		initialWatches: ["D111"],
		getAppToken: async () => "xapp-controlled",
		socketConnect: () => socket,
		classify: async () => {
			attempts++;
			return attempts === 1
				? new Promise((resolve) => {
						release = resolve;
					})
				: null;
		},
	});
	try {
		const starting = h.coordinator.start();
		await until(() => !!release && !!socket.onmessage);
		const edited = raw("No remaining work", { edited: { ts: ts(2) } });
		h.messages.set("D111", [edited]);
		socket.emit({
			type: "message",
			subtype: "message_changed",
			channel: "D111",
			message: edited,
			event_ts: ts(3),
		});
		await until(() => [...h.store.sources.values()][0]?.source.revisionId === ts(2));
		release?.(candidate);
		await starting;
		assert.equal((await h.day().snapshot()).items.length, 0);
		h.control.now += 1000;
		await h.coordinator.tick();
		assert.equal((await h.day().snapshot()).items.length, 0);
		assert.equal(attempts, 2);
	} finally {
		release?.(null);
		await h.coordinator.dispose();
	}
});

test("unwatched private socket envelopes are acknowledged without source reads or classification", async () => {
	const socket = new FakeSocket();
	const h = harness({
		initialWatches: ["D111"],
		getAppToken: async () => "xapp-controlled",
		socketConnect: () => socket,
	});
	try {
		await h.coordinator.start();
		await until(() => !!socket.onmessage);
		const calls = h.calls.length;
		socket.emit({ type: "message", channel: "D999", ...raw("Private unwatched") });
		await until(() => socket.sent.length === 1);
		assert.equal(h.calls.length, calls);
		assert.equal(h.control.classifyCalls, 1);
		assert.equal(h.store.sources.size, 1);
	} finally {
		await h.coordinator.dispose();
	}
});

test("actual Day outbox uses coordinator's mandatory client ledger and ledger-only reconciliation", async () => {
	const h = harness({ initialWatches: ["D111"] });
	try {
		await h.coordinator.start();
		const stablePort = h.coordinator.replies;
		await h.coordinator.stop();
		await h.coordinator.start();
		assert.equal(h.coordinator.replies, stablePort);
		for (const kind of ["accept", "draft_reply", "send_reply"] as const) {
			const item = (await h.day().snapshot()).items[0];
			assert.ok(item);
			const operation =
				kind === "accept"
					? { kind, itemId: item.id, expectedRevision: item.revision }
					: kind === "draft_reply"
						? { kind, itemId: item.id, expectedRevision: item.revision, body: "Controlled answer" }
						: {
								kind,
								itemId: item.id,
								expectedRevision: item.revision,
								body: "Controlled answer",
								draftRevision: item.replyDraft?.revision ?? 0,
							};
			await h.day().operate({ requestId: kind, operation });
		}
		await h.day().tick();
		const item = (await h.day().snapshot()).items[0];
		assert.equal(item?.phase, "closed");
		const row = [...h.days.values()][0]?.store.state?.records[0]?.outbox[0];
		assert.ok(row?.receipt);
		const before = h.calls.length;
		const reconciled = await h
			.replies()
			.reconcile(
				{ requestId: row.requestId, source: row.source, body: row.body },
				new AbortController().signal
			);
		assert.equal(reconciled.status, "delivered");
		assert.equal(h.calls.length, before);
		assert.equal(h.calls.filter((call) => call.method === "chat.postMessage").length, 1);
	} finally {
		await h.coordinator.dispose();
	}
});

test("verified source reaches knowledge callback before slow classification, including classification-none", async () => {
	const order: string[] = [];
	const h = harness({
		initialWatches: ["D111"],
		publishKnowledge: async (batch) => {
			order.push("source");
			assert.equal(batch.messages[0]?.citation.audience.visibility, "direct_message");
			assert.equal(batch.deletions.length, 0);
		},
		classify: async () => {
			order.push("classify");
			return null;
		},
	});
	try {
		await h.coordinator.start();
		assert.deepEqual(order, ["source", "classify"]);
		assert.equal((await h.day().snapshot()).items.length, 0);
		assert.equal([...h.store.sources.values()][0]?.knowledgeApplied, true);
		await h.coordinator.tick();
		assert.deepEqual(order, ["source", "classify"]);
	} finally {
		await h.coordinator.dispose();
	}
});

test("availability/configuration replacement aborts held classification before activating a new private actor", async () => {
	let release: ((result: unknown) => void) | undefined;
	const h = harness({
		initialWatches: ["D111"],
		classify: async () =>
			new Promise((resolve) => {
				release = resolve;
			}),
	});
	try {
		const starting = h.coordinator.start();
		await until(() => !!release);
		h.control.credential = { ...credential, connectionId: "connection-two", userId: "U333" };
		h.options.initialWatches = [];
		await h.coordinator.availabilityChanged();
		release?.(candidate);
		await starting;
		assert.equal(h.coordinator.status().actor?.userId, "U333");
		assert.equal((await h.day().snapshot()).items.length, 0);
		assert.equal((await h.days.get("T111:U111")?.day.snapshot())?.items.length, 0);
		assert.equal(h.coordinator.status().watchCount, 0);
	} finally {
		release?.(null);
		await h.coordinator.dispose();
	}
});

test("stop fences a classifier that ignores cancellation and prevents late capture or checkpoint completion", async () => {
	let release: ((result: unknown) => void) | undefined;
	const h = harness({
		initialWatches: ["D111"],
		classify: async () =>
			new Promise((resolve) => {
				release = resolve;
			}),
	});
	try {
		const starting = h.coordinator.start();
		await until(() => !!release);
		await h.coordinator.stop();
		release?.(candidate);
		await starting;
		assert.equal((await h.day().snapshot()).items.length, 0);
		assert.equal([...h.store.sources.values()][0]?.decision, null);
		assert.equal(h.coordinator.status().mode, "stopped");
	} finally {
		release?.(null);
		await h.coordinator.dispose();
	}
});
