import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackTransport } from "./transport";
import { SlackError } from "./types";

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
