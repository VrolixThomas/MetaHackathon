import assert from "node:assert/strict";
import { it } from "node:test";
import { HubSnapshotSchema } from "../../shared/contracts";
import { HUB_OPERATION_FAILED, HUB_UNAVAILABLE, createHubController } from "./controller";

const snapshot = (sequence = 1) =>
	HubSnapshotSchema.parse({
		sequence,
		refreshedAt: null,
		refreshing: false,
		viewer: { githubLogin: null, linearName: null },
		connections: { github: false, linear: false, model: false },
		repositories: [],
		reviews: [],
		tickets: [],
		jobs: [],
		notices: [],
		errors: [],
		preferences: { linearTeamIds: [], linearProjectIds: [], maxWorkers: 2 },
	});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("starts with no product content, validates a local snapshot, and disposes without accepting late reads", async () => {
	const pending = deferred<unknown>();
	const calls: unknown[] = [];
	const hub = createHubController(async (...args) => {
		calls.push(args);
		return pending.promise;
	});
	assert.equal(hub.store.getState().snapshot, null);
	const start = hub.start();
	assert.deepEqual(calls, [["query", "hub.snapshot", {}]]);
	hub.dispose();
	pending.resolve(snapshot());
	await start;
	assert.equal(hub.store.getState().snapshot, null);
});

it("an older snapshot read cannot overwrite the acknowledged result of an operation", async () => {
	const pending = deferred<unknown>();
	const hub = createHubController(async (_type, path) =>
		path === "hub.snapshot" ? pending.promise : { snapshot: snapshot(7), jobId: "actual-job" }
	);
	const start = hub.start();
	const result = await hub.operate({ kind: "refresh" });
	assert.equal(result?.jobId, "actual-job");
	pending.resolve(snapshot(2));
	await start;
	assert.equal(hub.store.getState().snapshot?.sequence, 7);
	hub.dispose();
});

it("operations use independent request IDs, parse their inputs, and retain busy until all finish", async () => {
	const first = deferred<unknown>();
	const second = deferred<unknown>();
	const inputs: { requestId: string; operation: unknown }[] = [];
	const hub = createHubController(async (_type, _path, input) => {
		inputs.push(input as (typeof inputs)[number]);
		return inputs.length === 1 ? first.promise : second.promise;
	});
	const one = hub.operate({ kind: "pause-work", jobId: "job-1" });
	const two = hub.operate({ kind: "resume-work", jobId: "job-2" });
	assert.notEqual(inputs[0]?.requestId, inputs[1]?.requestId);
	first.resolve({ snapshot: snapshot(3) });
	await one;
	assert.equal(hub.store.getState().busy, true);
	second.resolve({ snapshot: snapshot(4) });
	await two;
	assert.equal(hub.store.getState().busy, false);
	await assert.rejects(() =>
		hub.operate({ kind: "start-work", ticketId: "t", repositoryId: "r", brief: "" })
	);
	assert.equal(inputs.length, 2);
	hub.dispose();
});

it("provider failures expose fixed honest errors without inserting fallback snapshots", async () => {
	const hub = createHubController(async () => {
		throw new Error("private-provider-diagnostic");
	});
	await hub.start();
	assert.equal(hub.store.getState().snapshot, null);
	assert.equal(hub.store.getState().error, HUB_UNAVAILABLE);
	await hub.operate({ kind: "refresh" });
	assert.equal(hub.store.getState().error, HUB_OPERATION_FAILED);
	assert.doesNotMatch(JSON.stringify(hub.store.getState()), /private-provider/);
	hub.dispose();
});

it("malformed hub responses reject instead of inventing jobs or accepting unknown fields", async () => {
	const hub = createHubController(async () => ({ ...snapshot(), samples: [] }));
	await hub.start();
	assert.equal(hub.store.getState().snapshot, null);
	assert.equal(hub.store.getState().error, HUB_UNAVAILABLE);
	hub.dispose();
});

it("detail routes validate identity and cursors before IPC", async () => {
	const calls: unknown[] = [];
	const hub = createHubController(async (type, path, input) => {
		calls.push([type, path, input]);
		return { jobId: "job", cursor: 100, lines: ["recorded log"], truncated: true };
	});
	const page = await hub.jobLog("job", 0, 100);
	assert.deepEqual(page.lines, ["recorded log"]);
	assert.deepEqual(calls, [["query", "hub.jobLog", { jobId: "job", cursor: 0, limit: 100 }]]);
	await assert.rejects(() => hub.jobLog("job", -1));
	assert.equal(calls.length, 1);
	hub.dispose();
});

it("rejects cross-job log pages and cross-PR feedback rather than mislabelling real content", async () => {
	const hub = createHubController(async (_type, path) =>
		path === "hub.jobLog"
			? { jobId: "other-job", cursor: 1, lines: ["foreign output"], truncated: false }
			: [
					{
						id: "feedback",
						prId: "other-pr",
						author: "author",
						body: "foreign feedback",
						url: "https://github.com/test/repo/pull/2",
						createdAt: "2026-10-28T12:00:00.000Z",
						updatedAt: "2026-10-28T12:00:00.000Z",
						kind: "inline",
						state: null,
						path: null,
						line: null,
						commitSha: null,
						suggestion: null,
					},
				]
	);
	await assert.rejects(() => hub.jobLog("job"), /identity mismatch/);
	await assert.rejects(() => hub.feedback("pr"), /identity mismatch/);
	hub.dispose();
});
