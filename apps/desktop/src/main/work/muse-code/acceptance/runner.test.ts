import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import type { MuseCodeStatus } from "../../../../shared/contracts/coding-provider";
import type { CodingTaskResult } from "../../../agent/coding-worker";
import { type Checkpoint, inspectTask, load, save } from "../checkpoint";
import { ANSWER, QUESTION, cleanupFixture, createFixture, createOwnedRoot } from "./fixture";
import { type AcceptancePorts, runAcceptance } from "./runner";

const ready: MuseCodeStatus = {
	installed: true,
	version: "controlled-unit-port",
	auth: "account",
	billing: "subscription",
	tier: null,
	ready: true,
	error: null,
};
function controlled(mode: "pass" | "approval" | "premature-edit" | "failed-cancel" = "pass") {
	let calls = 0;
	const ports: AcceptancePorts = {
		transport: "controlled-test",
		probe: async () => ready,
		async run(input, _path, signal, audit) {
			calls++;
			audit.hostsOpened++;
			try {
				const task = await inspectTask(input);
				await mkdir(dirname(task.path), { recursive: true, mode: 0o700 });
				let state = await load(task.path);
				const isCancel = input.jobId.endsWith("-cancel");
				if (!state) {
					state = {
						version: 1,
						taskKey: task.key,
						musePath: "/controlled-unit-only",
						cliVersion: "controlled-unit-port",
						sessionId: isCancel ? "cancel-session" : "greeting-session",
						profileId: ":ask-me",
						phase: isCancel ? "running" : mode === "approval" ? "approval" : "question",
						commandId: "command",
						turnId: isCancel ? "cancel-turn" : "greeting-turn",
						contextDigest: "controlled",
						decisionDigest: "controlled",
						pendingQuestion: isCancel
							? null
							: {
									userInputId: "actual-controlled-prompt",
									questionId: "question",
									question: QUESTION,
								},
						result: null,
					} satisfies Checkpoint;
					audit.starts.push(state.sessionId);
					audit.turnStarts.push({
						sessionId: state.sessionId,
						turnId: state.turnId as string,
						commandId: "controlled-start-command",
					});
					await save(task.path, state);
					if (isCancel) {
						await writeFile(join(input.worktreePath, "cancel-started.txt"), "started\n");
						await new Promise<void>((_resolve, reject) => {
							const cancel = () => {
								audit.cancels.push({
									sessionId: state?.sessionId as string,
									turnId: state?.turnId as string,
									commandId: "controlled-cancel-command",
									status: "accepted",
								});
								reject(new DOMException("Controlled cancellation", "AbortError"));
							};
							if (signal.aborted) cancel();
							else signal.addEventListener("abort", cancel, { once: true });
						});
					}
					if (mode === "premature-edit")
						await writeFile(join(input.worktreePath, "greeting.cjs"), "// edited before answer\n");
					return { status: "needs-input", summary: "Controlled test question", question: QUESTION };
				}
				audit.resumes.push(state.sessionId);
				let result: CodingTaskResult;
				if (isCancel) {
					audit.terminals.push({
						sessionId: state.sessionId,
						turnId: state.turnId as string,
						terminal: mode === "failed-cancel" ? "failed" : "cancelled",
					});
					result = {
						status: "needs-input",
						summary: "Controlled retained terminal",
						question: "Inspect retained files?",
					};
				} else {
					assert.equal(input.decisionContext, `${QUESTION}\nUser decision: ${ANSWER}`);
					audit.terminals.push({
						sessionId: state.sessionId,
						turnId: state.turnId as string,
						terminal: "completed",
					});
					await writeFile(
						join(input.worktreePath, "greeting.cjs"),
						'module.exports = () => "Hello, Aurora!";\n'
					);
					result = { status: "completed", summary: "Controlled summary is not check proof" };
				}
				await save(task.path, { ...state, phase: "settled", pendingQuestion: null, result });
				return result;
			} finally {
				audit.hostsClosed++;
			}
		},
	};
	return { ports, calls: () => calls };
}
async function run(t: TestContext, ports: AcceptancePorts) {
	const result = await runAcceptance(
		{ musePath: null, answer: ANSWER, settleMs: 5, cancelStartTimeoutMs: 3000 },
		ports,
		new AbortController().signal
	);
	t.after(() => rm(result.owner.root, { recursive: true, force: true }));
	return result;
}

test("CONTROLLED transport: real Git isolation, exact question/resume, actual independent check, cancellation gates and owned cleanup", async (t) => {
	const { ports } = controlled();
	const result = await run(t, ports);
	assert.equal(result.report["status"], "passed", JSON.stringify(result.report));
	assert.equal(result.report["transport"], "controlled-test");
	assert.equal(result.report["fixtureCleaned"], true);
	assert.equal(result.report["sourcePreserved"], true);
	assert.equal(
		(result.report["coding"] as { checks: { exitCode: number; logBytes: number }[] }).checks[0]
			?.exitCode,
		0
	);
	assert.ok((result.report["coding"] as { checks: { logBytes: number }[] }).checks[0]?.logBytes);
	assert.equal(JSON.parse(await readFile(result.reportPath, "utf8")).status, "passed");
});

test("sign-in-required metadata prevents any task/session and cannot become subscription success", async (t) => {
	const fake = controlled();
	fake.ports.probe = async () => ({
		...ready,
		auth: "sign-in-required",
		billing: "unknown",
		ready: false,
		error: "sign-in-required",
	});
	const result = await run(t, fake.ports);
	assert.equal(result.report["status"], "blocked");
	assert.equal(result.report["failure"], "sign-in-required");
	assert.equal(fake.calls(), 0);
});

test("pending approval is retained and cannot satisfy actual question acceptance", async (t) => {
	const result = await run(t, controlled("approval").ports);
	assert.equal(result.report["status"], "blocked");
	assert.equal(result.report["failure"], "actual-single-question-not-observed");
	assert.equal(result.report["fixtureCleaned"], false);
});

test("files modified before the explicit question answer block acceptance", async (t) => {
	const result = await run(t, controlled("premature-edit").ports);
	assert.equal(result.report["status"], "blocked");
	assert.equal(result.report["failure"], "worker-edited-before-explicit-answer");
});

test("AbortError and accepted cancellation without an observed cancelled terminal never pass", async (t) => {
	const result = await run(t, controlled("failed-cancel").ports);
	assert.equal(result.report["status"], "blocked");
	assert.equal(result.report["failure"], "cancelled-terminal-not-observed");
	assert.equal(result.report["fixtureCleaned"], false);
});

test("cleanup refuses replaced ownership, retaining the fixture", async (t) => {
	const owner = await createOwnedRoot();
	t.after(() => rm(owner.root, { recursive: true, force: true }));
	await createFixture(owner);
	await writeFile(join(owner.root, "owner.json"), JSON.stringify({ token: "replacement" }));
	await assert.rejects(cleanupFixture(owner), /token changed/);
});

test("CLI refuses model-capable execution without explicit root opt-in", () => {
	const result = spawnSync(
		"bun",
		["run", join(import.meta.dirname, "cli.ts"), "--live-subscription", "--answer", ANSWER],
		{
			env: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
			encoding: "utf8",
			timeout: 10_000,
		}
	);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /MUSE_ROOT_LIVE_ACCEPTANCE=1/);
});
