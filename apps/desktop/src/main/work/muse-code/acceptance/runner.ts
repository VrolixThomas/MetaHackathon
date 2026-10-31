import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MuseCodeStatus } from "../../../../shared/contracts/coding-provider";
import type { CodingTaskInput, CodingTaskResult } from "../../../agent/coding-worker";
import { type Checkpoint, load } from "../checkpoint";
import { MuseCodeRuntimeError } from "../index";
import { ANSWER, QUESTION, cleanupFixture, createFixture, createOwnedRoot, git } from "./fixture";

export interface Audit {
	starts: string[];
	resumes: string[];
	turnStarts: { sessionId: string; turnId: string; commandId: string }[];
	cancels: { sessionId: string; turnId: string; commandId: string; status: "accepted" }[];
	terminals: { sessionId: string; turnId: string; terminal: string }[];
	hostsOpened: number;
	hostsClosed: number;
}
export const newAudit = (): Audit => ({
	starts: [],
	resumes: [],
	turnStarts: [],
	cancels: [],
	terminals: [],
	hostsOpened: 0,
	hostsClosed: 0,
});
export interface AcceptancePorts {
	/** Live ports forward to the existing production adapter; controlled tests label their transport. */
	transport: "live-subscription" | "controlled-test";
	probe(path: string | null, signal: AbortSignal): Promise<MuseCodeStatus>;
	run(
		input: CodingTaskInput,
		path: string | null,
		signal: AbortSignal,
		audit: Audit
	): Promise<CodingTaskResult>;
}
class GateFailure extends Error {}
function requireGate(condition: unknown, code: string): asserts condition {
	if (!condition) throw new GateFailure(code);
}
const wait = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const checkpoint = (input: CodingTaskInput) => load(`${input.checkpointPath}.muse-code.json`);
const identity = (state: Checkpoint | null) => ({
	sessionId: state?.sessionId,
	turnId: state?.turnId,
});
async function regularText(file: string) {
	const stat = await lstat(file);
	requireGate(
		stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 100_000,
		"unsafe-fixture-file"
	);
	return readFile(file, "utf8");
}

export async function runAcceptance(
	options: {
		musePath: string | null;
		answer: typeof ANSWER;
		keepFixture?: boolean;
		settleMs?: number;
		cancelStartTimeoutMs?: number;
	},
	ports: AcceptancePorts,
	signal: AbortSignal
) {
	// No live calls occur merely by importing this module. CLI owns the explicit root opt-in.
	const owner = await createOwnedRoot();
	const audit = newAudit();
	const report: Record<string, unknown> = {
		version: 1,
		transport: ports.transport,
		startedAt: new Date().toISOString(),
		status: "blocked",
		stage: "probe",
		audit,
		nativeApp: "not-run",
		physicalMicrophone: "not-run",
		remotePublication: "not-run",
		fixtureCleaned: false,
		limitations: [
			"Local isolated SDK/runtime acceptance only; no Settings/UI, packaged app, microphone, GitHub write or installed updater verification.",
			"Vendor-owned durable sessions remain in the CLI's normal account directories; this harness never reads auth files or deletes vendor bookkeeping.",
		],
	};
	try {
		requireGate(options.answer === ANSWER, "explicit-fixture-answer-required");
		const status = await ports.probe(options.musePath, signal);
		// Exclude tier/account labels from stored evidence; retain only bounded status metadata.
		report["probe"] = {
			installed: status.installed,
			version: status.version,
			auth: status.auth,
			billing: status.billing,
			ready: status.ready,
			error: status.error,
		};
		requireGate(
			status.ready && status.auth === "account" && status.billing === "subscription",
			status.error ?? "subscription-not-established"
		);
		report["stage"] = "question";
		const fixture = await createFixture(owner);
		const greeting = await fixture.prepare("greeting", options.musePath);
		const asked = await ports.run(greeting.input, options.musePath, signal, audit);
		const before = await checkpoint(greeting.input);
		requireGate(
			asked.status === "needs-input" &&
				asked.question === QUESTION &&
				before?.phase === "question" &&
				before.pendingQuestion?.question === QUESTION &&
				before.turnId,
			"actual-single-question-not-observed"
		);
		report["question"] = {
			...identity(before),
			userInputId: before.pendingQuestion.userInputId,
			questionId: before.pendingQuestion.questionId,
			question: QUESTION,
			answerSource: "explicit-root-cli-option",
		};
		requireGate(
			(await git(greeting.input.worktreePath, "status", "--porcelain")) === "" &&
				(await git(greeting.input.worktreePath, "rev-parse", "HEAD")) === fixture.base,
			"worker-edited-before-explicit-answer"
		);
		report["stage"] = "resume-and-check";
		const resumed = await ports.run(
			{ ...greeting.input, decisionContext: `${QUESTION}\nUser decision: ${options.answer}` },
			options.musePath,
			signal,
			audit
		);
		const after = await checkpoint(greeting.input);
		requireGate(
			resumed.status === "completed" &&
				after?.phase === "settled" &&
				after.sessionId === before.sessionId &&
				after.turnId === before.turnId &&
				audit.terminals.some(
					(item) =>
						item.sessionId === before.sessionId &&
						item.turnId === before.turnId &&
						item.terminal === "completed"
				),
			"same-question-turn-not-completed"
		);
		requireGate(
			audit.starts.filter((id) => id === before.sessionId).length === 1 &&
				audit.resumes.includes(before.sessionId) &&
				audit.turnStarts.filter((item) => item.sessionId === before.sessionId).length === 1,
			"question-resume-created-new-turn-or-session"
		);
		requireGate(
			(await git(greeting.input.worktreePath, "rev-parse", "HEAD")) === fixture.base,
			"worker-committed-without-main"
		);
		requireGate(
			(await git(
				greeting.input.worktreePath,
				"diff",
				"--no-ext-diff",
				"--name-only",
				"HEAD",
				"--"
			)) === "greeting.cjs" &&
				!(await git(greeting.input.worktreePath, "ls-files", "--others", "--exclude-standard")),
			"unexpected-worker-file-changes"
		);
		for (const [name, content] of Object.entries(fixture.files))
			if (name !== "greeting.cjs")
				requireGate(
					(await regularText(join(greeting.input.worktreePath, name))) === content,
					"validation-or-conventions-modified"
				);
		const finalized = await fixture.runtime.finalize(greeting.job, signal);
		requireGate(
			finalized.changedFiles.length === 1 &&
				finalized.changedFiles[0] === "greeting.cjs" &&
				finalized.checks.length > 0 &&
				finalized.checks.every(
					(check) => check.exitCode === 0 && check.commitSha === finalized.headSha
				),
			"independent-check-failed"
		);
		report["coding"] = {
			...identity(after),
			baseSha: greeting.job.baseSha,
			headSha: finalized.headSha,
			changedFiles: finalized.changedFiles,
			checks: await Promise.all(
				finalized.checks.map(async (check) => {
					const log = await readFile(join(fixture.root, "owned", "logs", `${check.logId}.log`));
					return {
						...check,
						logBytes: log.length,
						logSha256: createHash("sha256").update(log).digest("hex"),
					};
				})
			),
		};
		requireGate((await fixture.snapshot()) === fixture.original, "source-fixture-mutated");
		report["stage"] = "cancel";
		const cancellation = await fixture.prepare("cancel", options.musePath);
		const controller = new AbortController();
		const cancelSignal = AbortSignal.any([
			signal,
			controller.signal,
			AbortSignal.timeout(options.cancelStartTimeoutMs ?? 90_000),
		]);
		let settled = false;
		const pending = ports.run(cancellation.input, options.musePath, cancelSignal, audit).then(
			(value) => {
				settled = true;
				return { value, error: null };
			},
			(error: unknown) => {
				settled = true;
				return { value: null, error };
			}
		);
		let running: Checkpoint | null = null;
		try {
			while (!settled && !cancelSignal.aborted) {
				const observed = await checkpoint(cancellation.input);
				const marker = await regularText(
					join(cancellation.input.worktreePath, "cancel-started.txt")
				).catch(() => null);
				if (observed?.phase === "running" && observed.turnId && marker?.trim() === "started") {
					running = observed;
					break;
				}
				await wait(50);
			}
		} finally {
			controller.abort();
			await pending;
		}
		const stopped = await pending;
		requireGate(running?.turnId, "cancel-active-turn-and-file-not-observed");
		requireGate(
			stopped.error instanceof Error && stopped.error.name === "AbortError",
			"cancel-did-not-reject-running-call"
		);
		requireGate(
			audit.cancels.some(
				(item) =>
					item.sessionId === running.sessionId &&
					item.turnId === running.turnId &&
					item.status === "accepted"
			),
			"cancel-acknowledgement-not-observed"
		);
		// Reattach unchanged input: adapter must reconcile its retained turn, never start a replacement.
		const reconciled = await ports.run(
			cancellation.input,
			options.musePath,
			AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
			audit
		);
		const cancelled = await checkpoint(cancellation.input);
		requireGate(
			reconciled.status === "needs-input" &&
				cancelled?.phase === "settled" &&
				cancelled.sessionId === running.sessionId &&
				cancelled.turnId === running.turnId &&
				audit.terminals.some(
					(item) =>
						item.sessionId === running.sessionId &&
						item.turnId === running.turnId &&
						item.terminal === "cancelled"
				),
			"cancelled-terminal-not-observed"
		);
		requireGate(
			audit.turnStarts.filter((item) => item.sessionId === running.sessionId).length === 1 &&
				audit.hostsOpened === audit.hostsClosed,
			"cancel-replayed-or-host-not-closed"
		);
		const settleMs = options.settleMs ?? 2000;
		await wait(settleMs);
		requireGate(
			!(await lstat(join(cancellation.input.worktreePath, "cancel-finished.txt")).catch(
				() => null
			)),
			"late-cancel-file-observed"
		);
		requireGate((await fixture.snapshot()) === fixture.original, "source-fixture-mutated");
		report["cancellation"] = {
			...identity(cancelled),
			terminal: "cancelled",
			acknowledged: true,
			observedNoLateWriteForMs: settleMs,
			retainedTurnReconciled: true,
		};
		report["sourcePreserved"] = true;
		report["stage"] = "complete";
		if (!options.keepFixture) {
			await cleanupFixture(owner);
			report["fixtureCleaned"] = true;
		}
		report["status"] = "passed";
	} catch (error) {
		report["failure"] =
			error instanceof GateFailure
				? error.message
				: error instanceof MuseCodeRuntimeError
					? error.code
					: signal.aborted
						? "operator-cancelled"
						: "acceptance-operation-failed";
		// Retain uncertain work and checkpoint evidence. Never replay, auto-approve, or clean unknown effects.
	}
	report["finishedAt"] = new Date().toISOString();
	const reportPath = join(owner.root, "report.json");
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	return { report, reportPath, owner };
}
