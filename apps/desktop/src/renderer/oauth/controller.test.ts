import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import {
	type OAuthProvider,
	OAuthStartInputSchema,
	type OAuthStatus,
} from "../../shared/contracts/oauth";
import type { ConversationApi } from "../conversation/api";
import {
	OAUTH_CONNECTING_POLL_INTERVAL_MS,
	OAUTH_POLL_INTERVAL_MS,
	type OAuthController,
	createOAuthController,
} from "./controller";
import { connected, deferred, status, statuses } from "./test-support";

const controllers: OAuthController[] = [];
function controller(call: ConversationApi["call"]) {
	const value = createOAuthController(call);
	controllers.push(value);
	return value;
}
afterEach(() => {
	for (const value of controllers.splice(0)) value.dispose();
});

it("starts empty, shares one read, and only observes local status until an explicit action", async () => {
	const read = deferred<unknown>();
	const calls: unknown[] = [];
	const value = controller(async (...args) => {
		calls.push(args);
		return read.promise;
	});
	assert.deepEqual(value.store.getState().rows, []);
	assert.equal(value.store.getState().busy, false);
	assert.equal(value.store.getState().loading, false);
	assert.deepEqual(calls, []);
	const rowCounts: number[] = [];
	value.store.subscribe((state) => rowCounts.push(state.rows.length));
	const first = value.start();
	assert.equal(value.start(), first);
	assert.equal(value.reload(), first);
	assert.equal(value.store.getState().loading, true);
	assert.deepEqual(calls, [["query", "oauth.status", {}]]);
	read.resolve(statuses());
	await first;
	assert.deepEqual(value.store.getState().rows, statuses());
	assert.equal(value.store.getState().loading, false);
	assert.ok(rowCounts.every((count) => count === 0 || count === 3));
	await value.start();
	assert.equal(calls.length, 1);
});

it("uses exact mutation routes/inputs, fresh UUIDs, and validates public results", async () => {
	const calls: Parameters<ConversationApi["call"]>[] = [];
	const value = controller(async (...args) => {
		calls.push(args);
		const [, path, input] = args;
		if (path === "oauth.openSetup") return undefined;
		const provider = (input as { provider: OAuthProvider }).provider;
		return status(provider, { phase: path === "oauth.start" ? "connecting" : "disconnected" });
	});
	await value.connect("github");
	await value.cancel("github");
	await value.connect("linear");
	await value.disconnect("linear");
	await value.connect("github");
	await value.openSetup();
	const starts = calls.filter(([, path]) => path === "oauth.start");
	const requestIds = starts.map(([, , input]) => OAuthStartInputSchema.parse(input).requestId);
	assert.equal(new Set(requestIds).size, 3);
	for (const id of requestIds) assert.match(id, /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
	assert.deepEqual(
		calls.map(([type, path]) => [type, path]),
		[
			["mutation", "oauth.start"],
			["mutation", "oauth.cancel"],
			["mutation", "oauth.start"],
			["mutation", "oauth.disconnect"],
			["mutation", "oauth.start"],
			["mutation", "oauth.openSetup"],
		]
	);
	assert.deepEqual(calls[1]?.[2], { provider: "github" });
	assert.deepEqual(calls[3]?.[2], { provider: "linear" });
	assert.deepEqual(calls[5]?.[2], {});
});

it("polls at 3s normally and 1s while connecting; polling never starts provider or model work", async () => {
	const originalTimeout = globalThis.setTimeout;
	const originalClear = globalThis.clearTimeout;
	const timers = new Map<number, { callback: () => void; delay: number }>();
	let sequence = 0;
	globalThis.setTimeout = ((callback: () => void, delay = 0) => {
		timers.set(++sequence, { callback, delay });
		return sequence;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((id: number) => {
		timers.delete(id);
	}) as unknown as typeof clearTimeout;
	let rows = statuses();
	const calls: string[] = [];
	const value = controller(async (type, path) => {
		calls.push(`${type}:${path}`);
		return path === "oauth.status" ? rows : status("github", { phase: "connecting" });
	});
	try {
		await value.start();
		assert.equal(timers.size, 1);
		assert.equal([...timers.values()][0]?.delay, OAUTH_POLL_INTERVAL_MS);
		await value.connect("github");
		assert.equal(timers.size, 1);
		assert.equal([...timers.values()][0]?.delay, OAUTH_CONNECTING_POLL_INTERVAL_MS);
		rows = statuses(connected("github"));
		const scheduled = [...timers.entries()][0];
		assert.ok(scheduled);
		timers.delete(scheduled[0]);
		scheduled[1].callback();
		await value.reload();
		assert.equal(value.store.getState().rows[0]?.phase, "connected");
		assert.equal(timers.size, 1);
		assert.equal([...timers.values()][0]?.delay, OAUTH_POLL_INTERVAL_MS);
		assert.deepEqual(calls, ["query:oauth.status", "mutation:oauth.start", "query:oauth.status"]);
		value.dispose();
		assert.equal(timers.size, 0);
	} finally {
		value.dispose();
		globalThis.setTimeout = originalTimeout;
		globalThis.clearTimeout = originalClear;
	}
});

it("deduplicates starts and permits only one global browser login, including after its RPC settles", async () => {
	const login = deferred<unknown>();
	const calls: unknown[] = [];
	const value = controller(async (...args) => {
		calls.push(args);
		if (args[1] === "oauth.cancel") return status("slack");
		return (args[2] as { provider: OAuthProvider }).provider === "github"
			? status("github", { phase: "connecting" })
			: login.promise;
	});
	const first = value.connect("slack");
	assert.equal(value.connect("slack"), first);
	assert.equal(await value.disconnect("slack"), null);
	assert.equal(await value.connect("github"), null);
	assert.equal(await value.connect("linear"), null);
	assert.equal(calls.length, 1);
	assert.deepEqual(value.store.getState().pending, {
		github: null,
		linear: null,
		slack: "connect",
	});
	login.resolve(status("slack", { phase: "connecting" }));
	await first;
	assert.equal(value.store.getState().busy, false);
	assert.equal(await value.connect("github"), null);
	assert.equal(await value.connect("slack"), null);
	assert.equal(calls.length, 1);
	await value.cancel("slack");
	await value.connect("github");
	assert.equal(
		value.store.getState().rows.find((row) => row.provider === "github")?.phase,
		"connecting"
	);
	assert.equal(calls.length, 3);
});

it("cancel supersedes pending start without overlapping provider mutations or adopting a late account", async () => {
	const login = deferred<unknown>();
	const cancellation = deferred<unknown>();
	const calls: string[] = [];
	const value = controller(async (_type, path) => {
		calls.push(path);
		return path === "oauth.start" ? login.promise : cancellation.promise;
	});
	const seenAccounts: unknown[] = [];
	value.store.subscribe((state) => seenAccounts.push(state.rows[0]?.account));
	const start = value.connect("github");
	const cancel = value.cancel("github");
	assert.equal(value.cancel("github"), cancel);
	assert.equal(await value.connect("github"), null);
	assert.deepEqual(calls, ["oauth.start"]);
	assert.equal(value.store.getState().pending.github, "cancel");
	login.resolve(connected("github", "stale-account"));
	assert.equal(await start, null);
	assert.deepEqual(calls, ["oauth.start", "oauth.cancel"]);
	assert.equal(value.store.getState().busy, true);
	assert.deepEqual(value.store.getState().rows, []);
	cancellation.resolve(status("github"));
	await cancel;
	assert.equal(value.store.getState().rows[0]?.phase, "disconnected");
	assert.equal(value.store.getState().busy, false);
	assert.ok(seenAccounts.every((account) => account == null));
});

it("an old status cannot restore a saved account after disconnect/reconnect; the other provider still updates", async () => {
	const oldRead = deferred<unknown>();
	let reads = 0;
	const value = controller(async (_type, path) => {
		if (path === "oauth.status") {
			reads++;
			return reads === 1
				? statuses(connected("github", "old"))
				: reads === 2
					? oldRead.promise
					: statuses(connected("github", "replacement"));
		}
		return status("github", { phase: path === "oauth.start" ? "connecting" : "disconnected" });
	});
	await value.reload();
	const old = value.reload();
	await value.disconnect("github");
	assert.equal(value.store.getState().rows[0]?.account, null);
	await value.connect("github");
	oldRead.resolve(statuses(connected("github", "old"), connected("linear", "linear-current")));
	await old;
	assert.equal(value.store.getState().rows[0]?.phase, "connecting");
	assert.equal(value.store.getState().rows[0]?.account, null);
	assert.equal(value.store.getState().rows[1]?.account?.login, "linear-current");
	await value.reload();
	assert.equal(value.store.getState().rows[0]?.account?.login, "replacement");
});

it("a read started during a mutation cannot overwrite its eventual disconnect acknowledgement", async () => {
	const disconnect = deferred<unknown>();
	const read = deferred<unknown>();
	const value = controller(async (_type, path) =>
		path === "oauth.status" ? read.promise : disconnect.promise
	);
	const action = value.disconnect("github");
	const poll = value.reload();
	disconnect.resolve(status("github"));
	await action;
	read.resolve(statuses(connected("github", "stale")));
	await poll;
	assert.equal(value.store.getState().rows[0]?.phase, "disconnected");
	assert.equal(value.store.getState().rows[0]?.account, null);
});

it("failed disconnect/cancel actions remain visibly failed across successful background reads", async () => {
	for (const method of ["disconnect", "cancel"] as const) {
		let fail = true;
		const value = controller(async (_type, path) => {
			if (path === "oauth.status") return statuses(connected("github"));
			if (fail) throw new Error("private upstream diagnostic and token bytes");
			return status("github");
		});
		await value.reload();
		assert.equal(await value[method]("github"), null);
		assert.equal(value.store.getState().errors.github, "provider");
		assert.equal(value.store.getState().rows[0]?.phase, "connected");
		await value.reload();
		assert.equal(value.store.getState().errors.github, "provider");
		assert.doesNotMatch(JSON.stringify(value.store.getState()), /private upstream|token bytes/);
		fail = false;
		await value[method]("github");
		assert.equal(value.store.getState().errors.github, null);
		assert.equal(value.store.getState().rows[0]?.phase, "disconnected");
	}
});

it("a superseded read failure cannot replace a successful mutation with an old error", async () => {
	const read = deferred<unknown>();
	const value = controller(async (_type, path) =>
		path === "oauth.status" ? read.promise : status("github")
	);
	const poll = value.reload();
	await value.disconnect("github");
	read.reject(new Error("old failure"));
	await poll;
	assert.equal(value.store.getState().error, null);
	assert.equal(value.store.getState().rows[0]?.phase, "disconnected");
});

it("rejects missing/duplicate providers and unknown public/account fields without retaining response bytes", async () => {
	const invalid = [
		[],
		[status("github"), status("linear"), status("github")],
		[{ ...status("github"), accessToken: "private-value" }, status("linear"), status("slack")],
		[
			{
				...connected("github"),
				account: { ...connected("github").account, secret: "private-value" },
			},
			status("linear"),
			status("slack"),
		],
		[status("github"), { ...status("linear"), error: "raw upstream message" }, status("slack")],
	];
	for (const response of invalid) {
		let result: unknown = response;
		const value = controller(async () => result);
		await value.reload();
		assert.deepEqual(value.store.getState().rows, []);
		assert.equal(value.store.getState().error, "provider");
		assert.doesNotMatch(JSON.stringify(value.store.getState()), /private-value|raw upstream/);
		result = statuses();
		await value.reload();
		assert.equal(value.store.getState().error, null);
		assert.equal(value.store.getState().rows.length, 3);
	}
});

it("rejects foreign-provider and non-public mutation results and preserves acknowledged metadata", async () => {
	for (const response of [
		connected("linear"),
		{ ...connected("github"), refreshToken: "private-value" },
	]) {
		const value = controller(async (_type, path) =>
			path === "oauth.status" ? statuses() : response
		);
		await value.reload();
		assert.equal(await value.connect("github"), null);
		assert.equal(value.store.getState().rows[0]?.phase, "disconnected");
		assert.equal(value.store.getState().errors.github, "provider");
		assert.equal(value.store.getState().busy, false);
		assert.doesNotMatch(JSON.stringify(value.store.getState()), /private-value/);
	}
});

it("setup uses one explicit main action, validates void, and retains failure separately from polling", async () => {
	const opening = deferred<unknown>();
	const calls: unknown[] = [];
	const value = controller(async (...args) => {
		calls.push(args);
		return args[1] === "oauth.status" ? statuses() : opening.promise;
	});
	const first = value.openSetup();
	assert.equal(value.openSetup(), first);
	assert.equal(value.store.getState().setupBusy, true);
	assert.equal(value.store.getState().busy, true);
	assert.deepEqual(calls, [["mutation", "oauth.openSetup", {}]]);
	opening.resolve({ secret: "private-value" });
	await first;
	assert.equal(value.store.getState().setupError, "provider");
	await value.reload();
	assert.equal(value.store.getState().setupError, "provider");
	assert.equal(value.store.getState().busy, false);
	assert.doesNotMatch(JSON.stringify(value.store.getState()), /private-value/);
});

it("synchronous transport failures release read/setup locks so an explicit retry can work", async () => {
	let fail = true;
	const value = controller((_type, path) => {
		if (fail) throw new Error("private synchronous error");
		return Promise.resolve(path === "oauth.status" ? statuses() : undefined);
	});
	await value.reload();
	await value.openSetup();
	assert.equal(value.store.getState().error, "provider");
	assert.equal(value.store.getState().setupError, "provider");
	fail = false;
	await value.reload();
	await value.openSetup();
	assert.equal(value.store.getState().error, null);
	assert.equal(value.store.getState().setupError, null);
});

it("dispose rejects late reads, actions, setup completions and queued cancellation without further IPC", async () => {
	const pending = deferred<unknown>();
	const calls: string[] = [];
	const value = controller(async (_type, path) => {
		calls.push(path);
		return pending.promise;
	});
	const reading = value.start();
	const login = value.connect("github");
	const cancellation = value.cancel("github");
	const setup = value.openSetup();
	value.dispose();
	const snapshot = value.store.getState();
	let changes = 0;
	value.store.subscribe(() => changes++);
	await value.start();
	pending.resolve(statuses(connected("github")));
	await Promise.all([reading, login, cancellation, setup]);
	await Promise.all([
		value.start(),
		value.reload(),
		value.connect("linear"),
		value.cancel("github"),
		value.disconnect("linear"),
		value.openSetup(),
	]);
	assert.equal(value.store.getState(), snapshot);
	assert.equal(changes, 0);
	assert.deepEqual(calls, ["oauth.status", "oauth.start", "oauth.openSetup"]);
});

it("rejects invalid provider inputs before making an IPC request", () => {
	const value = controller(async () => {
		assert.fail("Invalid provider reached IPC");
	});
	assert.throws(() => value.connect("other" as OAuthStatus["provider"]));
	assert.throws(() => value.cancel("other" as OAuthStatus["provider"]));
	assert.throws(() => value.disconnect("other" as OAuthStatus["provider"]));
});
