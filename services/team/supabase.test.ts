import assert from "node:assert/strict";
import { test } from "node:test";
import { SupabaseRest } from "./supabase";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Transport ignored cancellation")), 500);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
const database = (transport: typeof fetch) =>
	new SupabaseRest({ url: "https://db.example", key: "controlled-only", fetch: transport });

test("Supabase request and rpc reject a pre-aborted caller before dispatch", async () => {
	let calls = 0;
	const db = database((async () => {
		calls++;
		return Response.json(null);
	}) as typeof fetch);
	await assert.rejects(db.request("/rest/v1/team_repositories", {}, AbortSignal.abort()));
	await assert.rejects(db.rpc("team_claim", {}, AbortSignal.abort()));
	assert.equal(calls, 0);
});

test("Supabase rpc races a fetch ignoring abort and discards its late response", async () => {
	const entered = deferred<void>();
	const response = deferred<Response>();
	let transportSignal: AbortSignal | null | undefined;
	let published = false;
	const db = database((async (_url, init) => {
		transportSignal = init?.signal;
		entered.resolve();
		return response.promise;
	}) as typeof fetch);
	const controller = new AbortController();
	const request = db.rpc("team_claim", {}, controller.signal).then(() => {
		published = true;
	});
	await bounded(entered.promise);
	controller.abort();
	await assert.rejects(bounded(request));
	assert.ok(transportSignal?.aborted);
	response.resolve(Response.json({ lease_token: "late" }));
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(published, false);
});

for (const status of [200, 503]) {
	test(`Supabase ${status} body read and stuck cancel are bounded by caller`, async () => {
		const entered = deferred<void>();
		const cancel = deferred<void>();
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>(
			{
				pull() {
					entered.resolve();
					return new Promise(() => {});
				},
				cancel() {
					cancelled = true;
					return cancel.promise;
				},
			},
			{ highWaterMark: 0 }
		);
		const db = database((async () => new Response(body, { status })) as typeof fetch);
		const controller = new AbortController();
		const request = db.request("/rest/v1/team_repositories", {}, controller.signal);
		await bounded(entered.promise);
		controller.abort();
		await assert.rejects(bounded(request));
		assert.equal(cancelled, true);
		cancel.resolve();
	});
}

test(
	"Supabase retains its 15s per-call deadline without caller, including a hanging body",
	{ timeout: 18000 },
	async () => {
		let cancelled = false;
		let transportSignal: AbortSignal | null | undefined;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const db = database((async (_url, init) => {
			transportSignal = init?.signal;
			return new Response(body);
		}) as typeof fetch);
		await assert.rejects(db.request("/rest/v1/team_repositories"));
		assert.ok(transportSignal?.aborted);
		assert.equal(cancelled, true);
	}
);
