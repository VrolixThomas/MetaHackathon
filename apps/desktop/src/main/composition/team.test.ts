import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type HubPersistence, WorkJobSchema, type WorkNotice } from "../../shared/contracts";
import { NEW_CODING_MODEL } from "../agent/coding-model";
import { readCodingModelAdmission } from "../work/coding-provider/pin";
import { admitAppliedTeamJob } from "./team";

const time = "2026-11-02T00:00:00Z";
const job = WorkJobSchema.parse({
	id: "team-applied",
	ticket: null,
	feedback: null,
	repositoryId: "owner/repo",
	repository: "owner/repo",
	codingProvider: { provider: "meta-api", musePath: null },
	state: "ready",
	branch: "muse/applied",
	worktreePath: "/controlled/worktree",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	brief: "Apply accepted exact source",
	summary: "Actual local application",
	createdAt: time,
	updatedAt: time,
	decisions: [],
	checks: [],
	changedFiles: [],
	pullRequest: null,
	error: null,
	pauseReason: null,
	reviewedAt: null,
});
const notice: WorkNotice = {
	id: "notice",
	kind: "work-ready",
	title: "Ready",
	detail: "Actual local application",
	jobId: job.id,
	prId: null,
	createdAt: time,
	announcedAt: null,
	seenAt: null,
};

test("team application pins before public admission, preserves legacy replay and rejects head drift", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "team-model-admission-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const existing of [false, true]) {
		const directory = join(root, existing ? "legacy" : "new");
		const state: HubPersistence = {
			version: 1,
			repositories: [],
			tickets: [],
			jobs: existing ? [structuredClone(job)] : [],
			notices: [],
			preferences: {
				linearTeamIds: [],
				linearProjectIds: [],
				maxWorkers: 1,
				autoApplySuggestions: false,
			},
		};
		let writes = 0;
		const hub = {
			allJobs: async () => structuredClone(state.jobs),
			update: async (mutate: (value: HubPersistence) => void) => {
				writes++;
				assert.deepEqual(
					await readCodingModelAdmission(directory, job),
					existing ? undefined : NEW_CODING_MODEL,
					"durable before exposure"
				);
				mutate(state);
			},
		};
		await admitAppliedTeamJob(hub, directory, job, notice);
		await admitAppliedTeamJob(hub, directory, job, notice);
		assert.equal(state.jobs.length, 1);
		assert.equal(state.notices.length, existing ? 0 : 1);
		assert.equal(writes, 2);
		await assert.rejects(
			admitAppliedTeamJob(hub, directory, { ...job, headSha: "c".repeat(40) }, notice),
			/result changed/
		);
		assert.equal(state.jobs[0]?.headSha, job.headSha);
	}
});
