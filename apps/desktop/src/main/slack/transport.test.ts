import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackClient } from "./client";
import { credential, privateChannel, rawMessage, source } from "./test-support";
import { SlackTransport } from "./transport";
import { SlackError } from "./types";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function controlledClock() {
	let now = 0;
	const sleepers: Array<{ at: number; resolve: () => void }> = [];
	return {
		now: () => now,
		wait: (ms: number) => new Promise<void>((resolve) => sleepers.push({ at: now + ms, resolve })),
		async advance(value: number) {
			now = value;
			for (const sleeper of sleepers.splice(0)) {
				if (sleeper.at <= now) sleeper.resolve();
				else sleepers.push(sleeper);
			}
			await flush();
		},
	};
}
function slackFailure(code: SlackError["code"], retryAfterSeconds?: number) {
	return (error: unknown) => {
		assert.ok(error instanceof SlackError);
		assert.equal(error.code, code);
		if (retryAfterSeconds !== undefined) assert.equal(error.retryAfterSeconds, retryAfterSeconds);
		return true;
	};
}
function controlledClient(clock = controlledClock()) {
	let account = credential;
	const requests: Array<{ method: string; at: number }> = [];
	const options = {
		...clock,
		getCredential: async () => account,
		historyIntervalMs: 1500,
		fetch: (async (url: string | URL | Request) => {
			const method = String(url).split("/").at(-1) ?? "";
			requests.push({ method, at: clock.now() });
			if (method === "conversations.info")
				return Response.json({ ok: true, channel: privateChannel() });
			if (method === "conversations.members")
				return Response.json({ ok: true, members: ["U123", "U456"] });
			return Response.json({ ok: true, messages: [rawMessage] });
		}) as typeof fetch,
	};
	return {
		client: new SlackClient(options),
		clock,
		requests,
		changeAccount: () => {
			account = { ...credential, connectionId: "new-account" };
		},
	};
}

test("source inspection 1120ms after background history waits for its slot after fresh membership", async () => {
	const { client, clock, requests } = controlledClient();
	await client.history({ conversationId: "D123" });
	await clock.advance(1120);
	const inspection = client.sourceMessage(source);
	await flush();
	assert.deepEqual(
		requests.map((row) => row.method),
		[
			"conversations.info",
			"conversations.members",
			"conversations.history",
			"conversations.info",
			"conversations.members",
		]
	);
	await clock.advance(1499);
	assert.equal(requests.length, 5);
	await clock.advance(1500);
	assert.equal((await inspection).text, rawMessage.text);
	assert.deepEqual(requests.at(-1), { method: "conversations.history", at: 1500 });
});

test("queued client cancellation emits no history request and account changes emit no old result", async () => {
	for (const cancel of [true, false]) {
		const { client, clock, requests, changeAccount } = controlledClient();
		await client.history({ conversationId: "D123" });
		const controller = new AbortController();
		const inspection = client.sourceMessage(source, controller.signal);
		const rejected = assert.rejects(
			inspection,
			slackFailure(cancel ? "cancelled" : "stale-connection")
		);
		await flush();
		if (cancel) controller.abort();
		else changeAccount();
		await clock.advance(1500);
		await rejected;
		assert.equal(
			requests.filter((row) => row.method === "conversations.history").length,
			cancel ? 1 : 2
		);
	}
});

test("read and metadata methods send form fields with exact identity and pagination values", async () => {
	const cursor = "cursor+with/slash= &unicode-€";
	const cases = [
		["users.info", { user: "W123" }],
		["auth.test", {}],
		[
			"users.conversations",
			{
				types: "public_channel,private_channel,im,mpim",
				cursor,
				limit: 15,
				exclude_archived: true,
			},
		],
		["conversations.info", { channel: "D123" }],
		["conversations.members", { channel: "D123", cursor, limit: 200 }],
		[
			"conversations.history",
			{
				channel: "D123",
				cursor,
				oldest: "1700000000.000001",
				latest: "1700000002.000003",
				inclusive: true,
				limit: 15,
			},
		],
		[
			"conversations.replies",
			{ channel: "D123", cursor, ts: "1700000000.000001", inclusive: false, limit: 15 },
		],
		["apps.connections.open", {}],
	] as const;
	const seen: string[] = [];
	for (const [method, fields] of cases) {
		const transport = new SlackTransport({
			historyIntervalMs: 0,
			fetch: (async (input, init) => {
				assert.equal(String(input), `https://slack.com/api/${method}`);
				assert.equal(init?.method, "POST");
				assert.equal(new Headers(init?.headers).get("authorization"), "Bearer controlled-token");
				// Reproduce the live read failure when parameters are encoded as JSON.
				if (new Headers(init?.headers).get("content-type") !== "application/x-www-form-urlencoded")
					return Response.json({ ok: false, error: "user_not_found" });
				assert.deepEqual(
					Object.fromEntries(new URLSearchParams(String(init?.body))),
					Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value)]))
				);
				seen.push(method);
				return Response.json({ ok: true });
			}) as typeof fetch,
		});
		await transport.call(method, { token: "controlled-token", fields });
	}
	assert.deepEqual(
		seen,
		cases.map(([method]) => method)
	);
});

test("chat.postMessage remains JSON with verbatim text, thread identity and boolean flags", async () => {
	const fields = {
		channel: "D123",
		thread_ts: "1700000000.000001",
		text: "Exact reply + & = €\nsecond line",
		unfurl_links: false,
		reply_broadcast: false,
	};
	const transport = new SlackTransport({
		fetch: (async (_input, init) => {
			assert.equal(
				new Headers(init?.headers).get("content-type"),
				"application/json; charset=utf-8"
			);
			assert.deepEqual(JSON.parse(String(init?.body)), fields);
			return Response.json({ ok: true });
		}) as typeof fetch,
	});
	await transport.call("chat.postMessage", { token: "controlled-token", fields });
});

test("explicit form true and false override the method default", async () => {
	for (const [method, form] of [
		["users.info", false],
		["chat.postMessage", true],
	] as const) {
		const fields = { user: "W123", text: "Exact + & €", limit: 15, inclusive: false };
		const transport = new SlackTransport({
			fetch: (async (_input, init) => {
				assert.equal(
					new Headers(init?.headers).get("content-type"),
					form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8"
				);
				if (form)
					assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init?.body))), {
						user: "W123",
						text: fields.text,
						limit: "15",
						inclusive: "false",
					});
				else assert.deepEqual(JSON.parse(String(init?.body)), fields);
				return Response.json({ ok: true });
			}) as typeof fetch,
		});
		await transport.call(method, { fields, form });
	}
});

test("429 Retry-After is retained across calls with no automatic retry", async () => {
	let calls = 0;
	let now = 0;
	const transport = new SlackTransport({
		now: () => now,
		fetch: (async () => {
			calls++;
			return new Response("secret", { status: 429, headers: { "retry-after": "120" } });
		}) as typeof fetch,
	});
	for (let attempt = 0; attempt < 2; attempt++)
		await assert.rejects(
			transport.call("conversations.history", { token: "secret", bucket: "T123", fields: {} }),
			(error: unknown) =>
				error instanceof SlackError &&
				error.code === "rate-limited" &&
				error.retryAfterSeconds === 120
		);
	assert.equal(calls, 1);
	now = 120000;
	await assert.rejects(
		transport.call("conversations.history", { token: "secret", bucket: "T123" })
	);
	assert.equal(calls, 2);
});

test("default history budget is one request per method/minute across channels", async () => {
	let calls = 0;
	const transport = new SlackTransport({
		now: () => 0,
		fetch: (async () => {
			calls++;
			return Response.json({ ok: true });
		}) as typeof fetch,
	});
	await transport.call("conversations.history", { bucket: "T123", fields: { channel: "C1" } });
	await assert.rejects(
		transport.call("conversations.history", { bucket: "T123", fields: { channel: "C2" } }),
		(error: unknown) => error instanceof SlackError && error.retryAfterSeconds === 60
	);
	assert.equal(calls, 1);
});

test("cancellation bounds transports that ignore the AbortSignal", async () => {
	const controller = new AbortController();
	const transport = new SlackTransport({ fetch: (() => new Promise(() => {})) as typeof fetch });
	const pending = transport.call("auth.test", { signal: controller.signal });
	controller.abort();
	await assert.rejects(
		pending,
		(error: unknown) => error instanceof SlackError && error.code === "cancelled"
	);
});

test("invalid JSON, redirects, missing scopes, and excessive streaming bytes are sanitized", async () => {
	for (const response of [
		new Response("bad", { headers: { "content-type": "application/json" } }),
		Response.json({ ok: false, error: "missing_scope", needed: "private-secret" }),
		new Response("redirect-secret", { status: 302 }),
		Response.json({ ok: true, text: "x".repeat(101) }),
	]) {
		const transport = new SlackTransport({ fetch: (async () => response) as typeof fetch });
		await assert.rejects(
			transport.call("auth.test", { maxBytes: 100 }),
			(error: unknown) => error instanceof SlackError && !error.message.includes("secret")
		);
	}
});

test("short history and replies reads are FIFO: a recurring poll cannot overtake foreground/UI", async () => {
	for (const method of ["conversations.history", "conversations.replies"] as const) {
		const clock = controlledClock();
		const seen: Array<{ id: string; at: number }> = [];
		const transport = new SlackTransport({
			...clock,
			historyIntervalMs: 1500,
			fetch: (async (_url, init) => {
				seen.push({
					id: new URLSearchParams(String(init?.body)).get("channel") ?? "",
					at: clock.now(),
				});
				return Response.json({ ok: true });
			}) as typeof fetch,
		});
		const read = (id: string) => transport.call(method, { bucket: "T1", fields: { channel: id } });
		await read("background");
		const foreground = read("foreground");
		const ui = read("UI");
		const poll = read("background-again");
		await flush();
		await clock.advance(1499);
		assert.equal(seen.length, 1);
		await clock.advance(1500);
		await foreground;
		await clock.advance(3000);
		await ui;
		await clock.advance(4500);
		await poll;
		assert.deepEqual(seen, [
			{ id: "background", at: 0 },
			{ id: "foreground", at: 1500 },
			{ id: "UI", at: 3000 },
			{ id: "background-again", at: 4500 },
		]);
	}
});

test("cancelling a queued middle read releases its position without consuming a pacing slot", async () => {
	const clock = controlledClock();
	let calls = 0;
	const transport = new SlackTransport({
		...clock,
		historyIntervalMs: 1500,
		fetch: (async () => {
			calls++;
			return Response.json({ ok: true });
		}) as typeof fetch,
	});
	await transport.call("conversations.history", {});
	const first = transport.call("conversations.history", {});
	const controller = new AbortController();
	const middle = assert.rejects(
		transport.call("conversations.history", { signal: controller.signal }),
		slackFailure("cancelled")
	);
	const last = transport.call("conversations.history", {});
	controller.abort();
	await middle;
	await flush();
	await clock.advance(1500);
	await first;
	await clock.advance(3000);
	await last;
	assert.equal(calls, 3);
});

test("HTTP429 fences all queued reads, including slots admitted before the response", async () => {
	for (const historyIntervalMs of [0, 1500]) {
		const clock = controlledClock();
		let calls = 0;
		let respond = (_response: Response) => {};
		const transport = new SlackTransport({
			...clock,
			historyIntervalMs,
			fetch: (() => {
				calls++;
				return new Promise<Response>((resolve) => {
					respond = resolve;
				});
			}) as typeof fetch,
		});
		const pending = Array.from({ length: 3 }, () =>
			assert.rejects(transport.call("conversations.history", {}), slackFailure("rate-limited", 120))
		);
		await flush();
		await clock.advance(4500); // Even a slow response cannot release another reserved read.
		assert.equal(calls, 1);
		respond(
			new Response("ignored provider body", { status: 429, headers: { "retry-after": "120" } })
		);
		await Promise.all(pending);
		assert.equal(calls, 1);
		await clock.advance(124499);
		await assert.rejects(
			transport.call("conversations.history", {}),
			slackFailure("rate-limited", 1)
		);
		assert.equal(calls, 1);
		await clock.advance(124500);
		const next = transport.call("conversations.history", {});
		await flush();
		assert.equal(calls, 2);
		respond(Response.json({ ok: true }));
		await next;
	}
});

test("writes and ambiguous transport failures are never queued or retried", async () => {
	for (const rateLimited of [true, false]) {
		let calls = 0;
		const transport = new SlackTransport({
			historyIntervalMs: 1500,
			fetch: (async () => {
				calls++;
				if (rateLimited)
					return new Response(null, { status: 429, headers: { "retry-after": "120" } });
				throw new Error("unknown send outcome");
			}) as typeof fetch,
		});
		await assert.rejects(
			transport.call("chat.postMessage", {}),
			slackFailure(rateLimited ? "rate-limited" : "provider")
		);
		await flush();
		assert.equal(calls, 1);
		if (rateLimited) {
			await assert.rejects(
				transport.call("chat.postMessage", {}),
				slackFailure("rate-limited", 120)
			);
			assert.equal(calls, 1);
		}
	}
});

test("short-read queue has a global bound and cancellation recovers capacity", async () => {
	const controller = new AbortController();
	let calls = 0;
	const transport = new SlackTransport({
		historyIntervalMs: 1500,
		fetch: (() => {
			calls++;
			return new Promise(() => {});
		}) as typeof fetch,
	});
	const pending = Array.from({ length: 8 }, () =>
		assert.rejects(
			transport.call("conversations.history", { signal: controller.signal }),
			slackFailure("cancelled")
		)
	);
	await flush();
	await assert.rejects(
		transport.call("conversations.replies", { bucket: "other" }),
		slackFailure("capacity")
	);
	assert.equal(calls, 1);
	controller.abort();
	await Promise.all(pending);
	const nextController = new AbortController();
	const next = assert.rejects(
		transport.call("conversations.replies", { signal: nextController.signal }),
		slackFailure("cancelled")
	);
	await flush();
	assert.equal(calls, 2);
	nextController.abort();
	await next;
});

test("HTTP active capacity is rechecked after a local pacing wait", async () => {
	const clock = controlledClock();
	const controller = new AbortController();
	let reads = 0;
	const transport = new SlackTransport({
		...clock,
		historyIntervalMs: 1500,
		fetch: (async (url) => {
			if (String(url).endsWith("conversations.history")) {
				reads++;
				return Response.json({ ok: true });
			}
			return new Promise(() => {});
		}) as typeof fetch,
	});
	await transport.call("conversations.history", {});
	const queued = assert.rejects(
		transport.call("conversations.history", {}),
		slackFailure("capacity")
	);
	await flush();
	const active = Array.from({ length: 4 }, () =>
		assert.rejects(
			transport.call("auth.test", { signal: controller.signal }),
			slackFailure("cancelled")
		)
	);
	await assert.rejects(transport.call("users.info", {}), slackFailure("capacity"));
	await clock.advance(1500);
	await queued;
	assert.equal(reads, 1);
	controller.abort();
	await Promise.all(active);
	await transport.call("conversations.history", {});
	assert.equal(reads, 2);
});

test("bucket capacity is bounded at 256 and existing buckets remain usable", async () => {
	let calls = 0;
	const transport = new SlackTransport({
		historyIntervalMs: 0,
		fetch: (async () => {
			calls++;
			return Response.json({ ok: true });
		}) as typeof fetch,
	});
	for (let i = 0; i < 256; i++)
		await transport.call("conversations.history", { bucket: String(i) });
	await assert.rejects(
		transport.call("conversations.history", { bucket: "overflow" }),
		slackFailure("capacity")
	);
	await transport.call("conversations.history", { bucket: "0" });
	assert.equal(calls, 257);
});

test("invalid and backwards clocks cannot silently grant commercial quota", async () => {
	let now = 1000;
	let calls = 0;
	const transport = new SlackTransport({
		now: () => now,
		fetch: (async () => {
			calls++;
			return Response.json({ ok: true });
		}) as typeof fetch,
	});
	await transport.call("conversations.history", {});
	now = -1000;
	await assert.rejects(
		transport.call("conversations.history", {}),
		slackFailure("rate-limited", 60)
	);
	now = Number.NaN;
	await assert.rejects(transport.call("conversations.history", {}), slackFailure("invalid-data"));
	now = 60999;
	await assert.rejects(
		transport.call("conversations.history", {}),
		slackFailure("rate-limited", 1)
	);
	now = 61000;
	await transport.call("conversations.history", {});
	assert.equal(calls, 2);
});

test("zero interval remains immediate while non-internal long intervals fail promptly", async () => {
	for (const interval of [0, 1501, 60000]) {
		let calls = 0;
		const transport = new SlackTransport({
			historyIntervalMs: interval,
			now: () => 0,
			fetch: (async () => {
				calls++;
				return Response.json({ ok: true });
			}) as typeof fetch,
		});
		await transport.call("conversations.replies", {});
		const next = transport.call("conversations.replies", {});
		if (!interval) await next;
		else await assert.rejects(next, slackFailure("rate-limited", Math.ceil(interval / 1000)));
		assert.equal(calls, interval ? 1 : 2);
	}
});

test("real monotonic timers space short read starts", async () => {
	const starts: number[] = [];
	const transport = new SlackTransport({
		historyIntervalMs: 20,
		fetch: (async () => {
			starts.push(performance.now());
			return Response.json({ ok: true });
		}) as typeof fetch,
	});
	await Promise.all(Array.from({ length: 3 }, () => transport.call("conversations.history", {})));
	assert.equal(starts.length, 3);
	for (let i = 1; i < starts.length; i++) assert.ok((starts[i] ?? 0) - (starts[i - 1] ?? 0) >= 19);
});

test(
	"a frozen clock/wait is bounded by the real ten-second admission deadline",
	{ timeout: 15000 },
	async () => {
		let calls = 0;
		const transport = new SlackTransport({
			historyIntervalMs: 1500,
			now: () => 0,
			wait: () => new Promise(() => {}),
			fetch: (async () => {
				calls++;
				return Response.json({ ok: true });
			}) as typeof fetch,
		});
		await transport.call("conversations.history", {});
		const began = performance.now();
		await assert.rejects(transport.call("conversations.history", {}), slackFailure("cancelled"));
		assert.ok(performance.now() - began < 12000);
		assert.equal(calls, 1);
	}
);

test("queued reads retain fixed authorization failures and release the next slot", async () => {
	for (const [providerError, code] of [
		["invalid_auth", "connection-required"],
		["missing_scope", "missing-scope"],
		["not_in_channel", "access-denied"],
	] as const) {
		const clock = controlledClock();
		let calls = 0;
		const transport = new SlackTransport({
			...clock,
			historyIntervalMs: 1500,
			fetch: (async () => {
				calls++;
				return Response.json(calls === 2 ? { ok: false, error: providerError } : { ok: true });
			}) as typeof fetch,
		});
		await transport.call("conversations.history", {});
		const rejected = assert.rejects(
			transport.call("conversations.history", {}),
			slackFailure(code)
		);
		const next = transport.call("conversations.history", {});
		await flush();
		await clock.advance(1500);
		await rejected;
		await clock.advance(3000);
		await next;
		assert.equal(calls, 3);
	}
});
