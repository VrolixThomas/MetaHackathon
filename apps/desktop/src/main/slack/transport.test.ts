import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackTransport } from "./transport";
import { SlackError } from "./types";

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
