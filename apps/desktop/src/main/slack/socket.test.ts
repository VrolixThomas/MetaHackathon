import assert from "node:assert/strict";
import { test } from "node:test";
import { SlackClient } from "./client";
import { type SlackSocket, SlackSocketMode, type SlackSocketState } from "./socket";
import { credential, requestFields } from "./test-support";

class FakeSocket implements SlackSocket {
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	readonly sent: string[] = [];
	closed = false;
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.closed = true;
	}
	emit(payload: unknown) {
		this.onmessage?.({ data: JSON.stringify(payload) });
	}
}
async function until(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.ok(predicate(), "controlled socket condition did not settle");
}
function socketClient(
	response = { ok: true, url: "wss://wss-primary.slack.com/link?ticket=private-ticket" }
) {
	let opens = 0;
	return {
		client: new SlackClient({
			getCredential: async () => credential,
			fetch: (async (input, init) => {
				assert.equal(String(input), "https://slack.com/api/apps.connections.open");
				assert.equal(new Headers(init?.headers).get("authorization"), "Bearer xapp-controlled");
				assert.deepEqual(requestFields("apps.connections.open", init), {});
				opens++;
				return Response.json(response);
			}) as typeof fetch,
		}),
		opens: () => opens,
	};
}

test("missing app token explicitly selects polling without an API or socket connection", async () => {
	const h = socketClient();
	const states: SlackSocketState[] = [];
	await new SlackSocketMode({
		client: h.client,
		intake: { receive: async () => "ignored" },
		getAppToken: async () => undefined,
		connect: () => {
			throw new Error("unexpected dial");
		},
		onState: (state) => states.push(state),
	}).run(new AbortController().signal);
	assert.equal(h.opens(), 0);
	assert.deepEqual(states, [{ mode: "poll", reason: "unconfigured" }]);
});

test("Socket Mode uses xapp handshake, awaits durable intake before ACK and closes on cancellation", async () => {
	const h = socketClient();
	const socket = new FakeSocket();
	const controller = new AbortController();
	let release: (() => void) | undefined;
	let received: unknown;
	const mode = new SlackSocketMode({
		client: h.client,
		getAppToken: async () => "xapp-controlled",
		connect: (url) => {
			assert.equal(new URL(url).protocol, "wss:");
			return socket;
		},
		intake: {
			receive: async (payload) => {
				received = payload;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return "applied";
			},
		},
	});
	const running = mode.run(controller.signal);
	await until(() => !!socket.onmessage);
	socket.onopen?.();
	socket.emit({
		type: "events_api",
		envelope_id: "envelope-1",
		payload: { controlled: "source-event" },
	});
	await until(() => !!received);
	assert.equal(socket.sent.length, 0);
	release?.();
	await until(() => socket.sent.length === 1);
	assert.deepEqual(JSON.parse(socket.sent[0] ?? ""), { envelope_id: "envelope-1" });
	controller.abort();
	await running;
	assert.equal(socket.closed, true);
	assert.equal(h.opens(), 1);
});

test("failed intake withholds ACK and reports polling rather than losing an event", async () => {
	const h = socketClient();
	const socket = new FakeSocket();
	const states: SlackSocketState[] = [];
	const running = new SlackSocketMode({
		client: h.client,
		intake: {
			receive: async () => {
				throw new Error("private-source-error");
			},
		},
		getAppToken: async () => "xapp-controlled",
		connect: () => socket,
		onState: (value) => states.push(value),
	}).run(new AbortController().signal);
	await until(() => !!socket.onmessage);
	socket.emit({ type: "events_api", envelope_id: "envelope-1", payload: {} });
	await running;
	assert.equal(socket.sent.length, 0);
	assert.deepEqual(states.at(-1), { mode: "poll", reason: "provider" });
});

test("refresh disconnect obtains a new URL; disabling Socket Mode stops retry", async () => {
	const h = socketClient();
	const sockets: FakeSocket[] = [];
	const states: SlackSocketState[] = [];
	const running = new SlackSocketMode({
		client: h.client,
		intake: { receive: async () => "ignored" },
		getAppToken: async () => "xapp-controlled",
		connect: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		delay: async () => {},
		onState: (state) => states.push(state),
	}).run(new AbortController().signal);
	await until(() => !!sockets[0]?.onmessage);
	sockets[0]?.emit({ type: "disconnect", reason: "refresh_requested" });
	await until(() => !!sockets[1]?.onmessage);
	sockets[1]?.emit({ type: "disconnect", reason: "link_disabled" });
	await running;
	assert.equal(h.opens(), 2);
	assert.deepEqual(states.at(-1), { mode: "poll", reason: "disconnected" });
});

test("untrusted socket URL and oversized frames cannot trigger external dials or ingestion", async () => {
	const h = socketClient({ ok: true, url: "wss://attacker.example/socket" });
	let dials = 0;
	await new SlackSocketMode({
		client: h.client,
		intake: { receive: async () => "ignored" },
		getAppToken: async () => "xapp-controlled",
		connect: () => {
			dials++;
			return new FakeSocket();
		},
		delay: async () => {},
	}).run(new AbortController().signal);
	assert.equal(dials, 0);
	const good = socketClient();
	const socket = new FakeSocket();
	const running = new SlackSocketMode({
		client: good.client,
		intake: {
			receive: async () => {
				throw new Error("unexpected intake");
			},
		},
		getAppToken: async () => "xapp-controlled",
		connect: () => socket,
	}).run(new AbortController().signal);
	await until(() => !!socket.onmessage);
	socket.onmessage?.({ data: "x".repeat(2 * 1024 * 1024 + 1) });
	await running;
	assert.equal(socket.closed, true);
});
