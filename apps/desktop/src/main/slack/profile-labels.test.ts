import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackProfileLabels } from "./profile-labels";
import { credential } from "./test-support";
import { SlackError } from "./types";

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function fixture() {
	const clock = { now: 0 };
	const account = { current: credential };
	const calls: { method: string; fields: Record<string, string | number> }[] = [];
	let handler: (
		method: string,
		fields: Record<string, string | number>
	) => unknown | Promise<unknown> = (_method, fields) => ({
		user: { id: fields["user"], profile: { display_name: `Person ${fields["user"]}` } },
	});
	const labels = new SlackProfileLabels({
		now: () => clock.now,
		assertCurrent: async (candidate, signal) => {
			if (signal.aborted) throw new SlackError("cancelled");
			if (
				["connectionId", "workspaceId", "userId", "appId"].some(
					(key) =>
						candidate[key as keyof typeof candidate] !==
						account.current[key as keyof typeof candidate]
				)
			)
				throw new SlackError("stale-connection");
		},
		request: async (_candidate, method, fields) => {
			calls.push({ method, fields });
			return handler(method, fields);
		},
	});
	return {
		labels,
		calls,
		clock,
		account,
		setHandler(next: typeof handler) {
			handler = next;
		},
	};
}
const signal = () => new AbortController().signal;
const dm = (user = "U456") => ({ id: "D123", user, is_im: true });
const profile = (name: string) => ({ user: { id: "U456", profile: { display_name: name } } });

test("peer labels cache across scans/token rotation and expire; account/workspace/user changes never reuse names", async () => {
	const h = fixture();
	assert.deepEqual(await h.labels.names(credential, [dm()], signal()), ["Person U456"]);
	h.clock.now = 5000;
	await h.labels.names(credential, [dm()], signal());
	h.account.current = { ...credential, accessToken: "rotated-token" };
	await h.labels.names(h.account.current, [dm()], signal());
	assert.equal(h.calls.length, 1);
	h.clock.now = 300001;
	h.setHandler(() => profile("Updated name"));
	assert.deepEqual(await h.labels.names(h.account.current, [dm()], signal()), ["Updated name"]);
	assert.equal(h.calls.length, 2);
	for (const replacement of [
		{ ...credential, workspaceId: "T999" },
		{ ...credential, userId: "U999" },
		{ ...credential, connectionId: "other-connection" },
	]) {
		h.account.current = replacement;
		await h.labels.names(replacement, [dm()], signal());
	}
	assert.equal(h.calls.length, 5);
});

test("failed lookups use honest fallback and a short retry cache without adding scopes", async () => {
	const h = fixture();
	h.setHandler(() => {
		throw new SlackError("missing-scope");
	});
	assert.deepEqual(await h.labels.names(credential, [dm()], signal()), ["U456"]);
	h.clock.now = 5000;
	await h.labels.names(credential, [dm()], signal());
	assert.equal(h.calls.length, 1);
	h.clock.now = 60001;
	h.setHandler(() => profile("Recovered name"));
	assert.deepEqual(await h.labels.names(credential, [dm()], signal()), ["Recovered name"]);
	assert.equal(h.calls.length, 2);
	h.account.current = { ...credential, scopes: ["im:read"] };
	assert.deepEqual(await h.labels.names(h.account.current, [dm()], signal()), ["U456"]);
	assert.equal(h.calls.length, 2);
});

test("group labels inspect only one bounded member page, mark partial lists and cache the hints", async () => {
	const h = fixture();
	h.setHandler((method, fields) =>
		method === "conversations.members"
			? { members: ["U123", "U456", "U789"], response_metadata: { next_cursor: "not-followed" } }
			: { user: { id: fields["user"], profile: { display_name: `Person ${fields["user"]}` } } }
	);
	const group = { id: "G123", name: "mpdm-source-name", is_mpim: true };
	assert.deepEqual(await h.labels.names(credential, [group], signal()), [
		"Person U456, Person U789, …",
	]);
	assert.deepEqual(h.calls[0], {
		method: "conversations.members",
		fields: { channel: "G123", limit: 15 },
	});
	assert.deepEqual(
		h.calls.slice(1).map((call) => call.fields["user"]),
		["U456", "U789"]
	);
	h.clock.now = 5000;
	await h.labels.names(credential, [group], signal());
	assert.equal(h.calls.length, 3);
});

test("a returned page has at most 15 uncached profile requests and three concurrent metadata calls", async () => {
	const h = fixture();
	let active = 0;
	let maximum = 0;
	h.setHandler(async (_method, fields) => {
		active++;
		maximum = Math.max(maximum, active);
		await new Promise((resolve) => setTimeout(resolve, 1));
		active--;
		return { user: { id: fields["user"], name: `Observed ${fields["user"]}` } };
	});
	const groups = Array.from({ length: 15 }, (_, index) => ({
		id: `G${index}`,
		is_mpim: true,
		members: Array.from({ length: 15 }, (_, peer) => `U${index * 15 + peer + 1000}`),
	}));
	const names = await h.labels.names(credential, groups, signal());
	assert.equal(h.calls.length, 15);
	assert.equal(maximum, 3);
	assert.equal(names.length, 15);
	assert.ok(names[1]?.includes("U1015"), "unlooked-up peers retain their actual IDs");
	assert.ok(names.every((name) => Array.from(name).length <= 300));
});

test("profile cache stays bounded instead of accumulating every discovered user", async () => {
	const h = fixture();
	for (let start = 0; start < 270; start += 15)
		await h.labels.names(
			credential,
			Array.from({ length: 15 }, (_, index) => dm(`U${1000 + start + index}`)),
			signal()
		);
	assert.equal(h.calls.length, 270);
	await h.labels.names(credential, [dm("U1269")], signal());
	assert.equal(h.calls.length, 270);
	await h.labels.names(credential, [dm("U1000")], signal());
	assert.equal(h.calls.length, 271);
});

test("cancellation rejects late profile work without caching or publishing it", async () => {
	const h = fixture();
	const started = deferred<void>();
	const late = deferred<unknown>();
	h.setHandler(() => {
		started.resolve();
		return late.promise;
	});
	const controller = new AbortController();
	const pending = h.labels.names(credential, [dm()], controller.signal);
	await started.promise;
	controller.abort();
	await assert.rejects(
		pending,
		(error: unknown) => error instanceof SlackError && error.code === "cancelled"
	);
	late.resolve(profile("Cancelled name"));
	h.setHandler(() => profile("Current name"));
	assert.deepEqual(await h.labels.names(credential, [dm()], signal()), ["Current name"]);
	assert.equal(h.calls.length, 2);
});

test("changed account fences a late profile and never inserts its name into the next account cache", async () => {
	const h = fixture();
	const started = deferred<void>();
	const late = deferred<unknown>();
	h.setHandler(() => {
		started.resolve();
		return late.promise;
	});
	const pending = h.labels.names(credential, [dm()], signal());
	await started.promise;
	h.account.current = { ...credential, workspaceId: "T999" };
	late.resolve(profile("Old workspace name"));
	await assert.rejects(
		pending,
		(error: unknown) => error instanceof SlackError && error.code === "stale-connection"
	);
	h.setHandler(() => profile("Current workspace name"));
	assert.deepEqual(await h.labels.names(h.account.current, [dm()], signal()), [
		"Current workspace name",
	]);
	assert.equal(h.calls.length, 2);
});

test("long group labels fit the conversation contract without splitting Unicode names", async () => {
	const h = fixture();
	h.setHandler((_method, fields) => ({
		user: { id: fields["user"], profile: { display_name: "😀".repeat(150) } },
	}));
	const [name] = await h.labels.names(
		credential,
		[{ id: "G123", is_mpim: true, members: ["U456", "U789"] }],
		signal()
	);
	assert.ok(name && name.length <= 300 && name.endsWith("…"));
	assert.ok(!/[\uD800-\uDBFF]…$/.test(name));
});

test("direct author resolution shares the profile cache without synthetic conversations or member requests", async () => {
	const h = fixture();
	assert.deepEqual(await h.labels.authors(credential, ["U456", "U456", "U789"], signal()), [
		{ id: "U456", name: "Person U456" },
		{ id: "U789", name: "Person U789" },
	]);
	assert.deepEqual(
		h.calls.map((call) => call.method),
		["users.info", "users.info"]
	);
	await h.labels.names(credential, [dm()], signal());
	assert.equal(h.calls.length, 2);
	await assert.rejects(
		h.labels.authors(
			credential,
			Array.from({ length: 16 }, (_, index) => `U${index}`),
			signal()
		),
		SlackError
	);
	assert.equal(h.calls.length, 2);
});
