import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type SQLite from "better-sqlite3";
import { PRApprovals } from ".";
import type { AttentionPresence } from "../../../shared/contracts";
import { HubStore } from "../../db/hub-store";
import { AttentionScheduler } from "../attention";
import { at, harness, head, policy, terms } from "./test-support";
const { Database } = (await import("bun:" + "sqlite")) as {
	Database: new (path: string) => SQLite.Database;
};
it("real SQLite reopen retains exact policies, checkpoints, uncertain action IDs and receipts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pr-delegation-test-"));
	const path = join(directory, "hub.db");
	const h = harness();
	try {
		let db = new Database(path);
		await new HubStore(db).saveState(h.state);
		db.close();
		db = new Database(path);
		const store = new HubStore(db);
		const saved = await store.loadState();
		assert.deepEqual(saved?.approvalPolicies, h.state.approvalPolicies);
		h.ports.update = async (mutate) => {
			const next = await store.loadState();
			assert.ok(next);
			mutate(next);
			await store.saveState(next);
			Object.assign(h.state, next);
		};
		h.ports.read = async () => (await store.loadState())?.approvalPolicies ?? [];
		const service = new PRApprovals(h.ports);
		await service.tick();
		assert.equal(h.p.status, "approved");
		const attempt = h.p.attempt;
		db.close();
		db = new Database(path);
		assert.deepEqual((await new HubStore(db).loadState())?.approvalPolicies?.[0]?.attempt, attempt);
		db.close();
		const crash = harness([
			policy({
				status: "submitting",
				attempt: {
					id: "unknown-before-crash",
					headSha: head,
					startedAt: new Date(at).toISOString(),
					receipt: null,
				},
			}),
		]);
		db = new Database(path);
		await new HubStore(db).saveState(crash.state);
		db.close();
		db = new Database(path);
		const current = new HubStore(db);
		crash.ports.read = async () => (await current.loadState())?.approvalPolicies ?? [];
		crash.ports.update = async (mutate) => {
			const s = await current.loadState();
			assert.ok(s);
			mutate(s);
			await current.saveState(s);
		};
		const reopened = new PRApprovals(crash.ports);
		await reopened.restore();
		await reopened.tick();
		assert.equal((await current.loadState())?.approvalPolicies?.[0]?.status, "uncertain");
		assert.equal(crash.submitted.length, 0);
		await reopened.dispose();
		db.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
it("approval attention uses the existing quiet/focus/dialog/typing deferrals without fake coding jobs", async () => {
	for (const patch of [
		{ enabled: false },
		{ focused: false },
		{ obscured: true },
		{ state: "user-speaking" },
		{ state: "interacting" },
		{ state: "responding" },
	]) {
		const h = harness([
			policy({
				terms: {
					...terms,
					conditions: [{ kind: "judgment", description: "Review new error behavior" }],
				},
			}),
		]);
		await h.service.tick();
		let now = at;
		const scheduler = new AttentionScheduler({
			read: async () => h.state,
			update: h.ports.update,
			isBusy: () => false,
			completed: () => false,
			now: () => now,
		});
		const presence: AttentionPresence = {
			sessionId: "session",
			enabled: true,
			state: "idle",
			focused: true,
			obscured: false,
			activitySequence: 0,
			...(patch as Partial<AttentionPresence>),
		};
		await scheduler.poll(presence);
		now += 2500;
		assert.equal((await scheduler.poll(presence)).claim, null);
		const enabled = {
			...presence,
			enabled: true,
			focused: true,
			obscured: false,
			state: "idle" as const,
		};
		await scheduler.poll(enabled);
		now += 2500;
		const claim = (await scheduler.poll(enabled)).claim;
		assert.ok(claim);
		assert.equal(claim?.items[0]?.kind, "pr-approval");
		assert.equal(claim?.items[0]?.jobId, h.p.id);
		assert.equal(h.state.jobs.length, 0);
		await h.service.revoke({ id: h.p.id, revision: 1 });
		await scheduler.changed();
		await assert.rejects(
			scheduler.resolve(
				{ sessionId: "session", turnId: "t", generation: 1, requestId: "r", claimId: claim.id },
				new AbortController().signal
			)
		);
		await scheduler.dispose();
	}
});
