import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
	ExecutionEvidenceSchema,
	ScenarioRunSchema,
	ScenarioTraceSchema,
} from "../../shared/contracts";
import type {
	ExecutionEvidence,
	PullRequest,
	ScenarioRun,
	ScenarioTrace,
} from "../../shared/contracts";
import { executionEnvironment } from "./environment";
import { runProcess } from "./process";

export interface RevisionWorktrees {
	runId: string;
	base: { path: string; sha: string };
	head: { path: string; sha: string };
}
const rawStepSchema = z.object({
	id: z.string().min(1),
	file: z.string().min(1),
	line: z.number().int().positive(),
	label: z.string().min(1),
	values: z.record(z.string(), z.json()),
	outcome: z.enum(["value", "continue", "return", "throw", "stopped"]).default("continue"),
});

/** Reject traversal and symlinks outside this runtime's detached checkout. */
export async function checkoutFile(checkout: string, path: string) {
	if (
		isAbsolute(path) ||
		path.includes("\\") ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("Expected a repository-relative file");
	const file = await realpath(resolve(checkout, path));
	const rel = relative(await realpath(checkout), file);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("File escapes checkout");
	return file;
}

export class ScenarioRunner {
	private readonly shutdown = new AbortController();
	private readonly jobs = new Set<Promise<unknown>>();
	constructor(
		private readonly logsDirectory: string,
		private readonly nodeExecutable = process.execPath
	) {}

	private async execute(
		pr: PullRequest,
		worktrees: RevisionWorktrees,
		revision: "base" | "head",
		command: string,
		args: string[],
		timeoutMs: number,
		signal?: AbortSignal
	) {
		if (timeoutMs < 1 || timeoutMs > 120_000)
			throw new Error("Execution timeout must be between 1 and 120000ms");
		const tree = worktrees[revision];
		const expected = revision === "base" ? pr.baseSha : pr.headSha;
		if (tree.sha !== expected) throw new Error("Worktree does not match PR revision");
		const sha = await runProcess({
			command: "git",
			args: ["rev-parse", "HEAD"],
			cwd: tree.path,
			env: executionEnvironment(),
			timeoutMs: 10_000,
			signal,
		});
		if (sha.exitCode !== 0 || sha.stdout.trim() !== expected)
			throw new Error("Checkout revision changed");
		const clean = await runProcess({
			command: "git",
			args: ["diff", "--exit-code", "HEAD", "--"],
			cwd: tree.path,
			env: executionEnvironment(),
			timeoutMs: 10_000,
			signal,
		});
		if (clean.exitCode !== 0)
			throw new Error("Checkout has tracked changes; cannot attribute execution to its commit");
		const runId = randomUUID();
		const startedAt = new Date().toISOString();
		const result = await runProcess({
			command,
			args,
			cwd: tree.path,
			timeoutMs,
			signal,
			maxOutputBytes: 2_000_000,
			env: executionEnvironment(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
		});
		const completedAt = new Date().toISOString();
		const finalSha = await runProcess({
			command: "git",
			args: ["rev-parse", "HEAD"],
			cwd: tree.path,
			env: executionEnvironment(),
			timeoutMs: 10_000,
		});
		const finalDiff = await runProcess({
			command: "git",
			args: ["diff", "--exit-code", expected, "--"],
			cwd: tree.path,
			env: executionEnvironment(),
			timeoutMs: 10_000,
		});
		const sourceChanged =
			finalSha.exitCode !== 0 || finalSha.stdout.trim() !== expected || finalDiff.exitCode !== 0;
		await mkdir(this.logsDirectory, { recursive: true, mode: 0o700 });
		const logPath = resolve(this.logsDirectory, `${runId}.json`);
		await writeFile(
			logPath,
			JSON.stringify(
				{
					runId,
					revision,
					commitSha: expected,
					startedAt,
					completedAt,
					command: [command, ...args],
					...result,
					sourceChanged,
				},
				null,
				2
			),
			{ mode: 0o600 }
		);
		const evidence = ExecutionEvidenceSchema.parse({
			kind: "execution",
			runId,
			commitSha: expected,
			command: [command, ...args],
			startedAt,
			completedAt,
			exitCode: result.exitCode ?? (result.timedOut ? 124 : result.aborted ? 130 : 1),
			logUrl: pathToFileURL(logPath).href,
		});
		if (sourceChanged)
			throw new Error(
				`Execution modified the pinned source; preserved for inspection. See ${evidence.logUrl}`
			);
		return { result, evidence };
	}

	async runBuilds(input: {
		pr: PullRequest;
		worktrees: RevisionWorktrees;
		command: string;
		args: string[];
		timeoutMs: number;
		signal?: AbortSignal;
	}): Promise<{ base: ExecutionEvidence; head: ExecutionEvidence }> {
		return this.owned(input.signal, async (signal) => {
			const base = await this.execute(
				input.pr,
				input.worktrees,
				"base",
				input.command,
				input.args,
				input.timeoutMs,
				signal
			);
			if (
				base.result.timedOut ||
				base.result.aborted ||
				base.result.exitCode === null ||
				base.result.outputTruncated
			)
				throw new Error(
					`Base build did not complete; cannot verify mechanical changes. See ${base.evidence.logUrl}`
				);
			const head = await this.execute(
				input.pr,
				input.worktrees,
				"head",
				input.command,
				input.args,
				input.timeoutMs,
				signal
			);
			if (
				head.result.timedOut ||
				head.result.aborted ||
				head.result.exitCode === null ||
				head.result.outputTruncated
			)
				throw new Error(
					`Head build did not complete; cannot verify mechanical changes. See ${head.evidence.logUrl}`
				);
			return { base: base.evidence, head: head.evidence };
		});
	}

	async runScenario(input: {
		pr: PullRequest;
		worktrees: RevisionWorktrees;
		scenarioId: string;
		title: string;
		inputs?: Record<string, z.infer<ReturnType<typeof z.json>>>;
		timeoutMs: number;
		signal?: AbortSignal;
	}) {
		if (!["A", "B", "C", "D"].includes(input.scenarioId))
			throw new Error("Unknown seeded scenario");
		return this.owned(input.signal, (signal) =>
			this.runBoth({
				...input,
				signal,
				args: ["--experimental-strip-types", "scenarios/run.mjs", input.scenarioId],
			})
		);
	}

	/** Main-only generated test port; callers must consciously authorize execution of reviewed code. */
	async runGeneratedTest(input: {
		pr: PullRequest;
		worktrees: RevisionWorktrees;
		title: string;
		inputs?: Record<string, z.infer<ReturnType<typeof z.json>>>;
		source: string;
		filename: string;
		timeoutMs: number;
		signal?: AbortSignal;
	}) {
		return this.owned(input.signal, async (signal) => {
			if (!/^[A-Za-z0-9_-]+\.mjs$/.test(input.filename) || input.source.length > 256_000)
				throw new Error("Invalid generated test");
			const name = `.metahackathon-${randomUUID()}-${input.filename}`;
			const created: string[] = [];
			try {
				for (const revision of ["base", "head"] as const) {
					const file = resolve(input.worktrees[revision].path, name);
					await writeFile(file, input.source, { flag: "wx", mode: 0o600 });
					created.push(file);
				}
				return await this.runBoth({ ...input, signal, args: ["--experimental-strip-types", name] });
			} finally {
				for (const file of created) await rm(file);
			}
		});
	}

	private owned<T>(
		signal: AbortSignal | undefined,
		work: (signal: AbortSignal) => Promise<T>
	): Promise<T> {
		if (this.shutdown.signal.aborted)
			return Promise.reject(new Error("Scenario runner has shut down"));
		const combined = signal
			? AbortSignal.any([signal, this.shutdown.signal])
			: this.shutdown.signal;
		const job = Promise.resolve().then(() => work(combined));
		this.jobs.add(job);
		void job
			.finally(() => {
				this.jobs.delete(job);
			})
			.catch(() => {});
		return job;
	}

	async dispose() {
		this.shutdown.abort();
		await Promise.allSettled([...this.jobs]);
	}

	private async runBoth(input: {
		pr: PullRequest;
		worktrees: RevisionWorktrees;
		title: string;
		inputs?: Record<string, z.infer<ReturnType<typeof z.json>>>;
		args: string[];
		timeoutMs: number;
		signal?: AbortSignal;
	}): Promise<{ trace: ScenarioTrace; results: { base: unknown; head: unknown } }> {
		const observations: { base?: unknown; head?: unknown } = {};
		const run = async (revision: "base" | "head"): Promise<ScenarioRun> => {
			const { result, evidence } = await this.execute(
				input.pr,
				input.worktrees,
				revision,
				this.nodeExecutable,
				input.args,
				input.timeoutMs,
				input.signal
			);
			const steps = [];
			if (result.outputTruncated)
				throw new Error(`Trace exceeded output limit; see ${evidence.logUrl}`);
			for (const line of result.stdout.split("\n")) {
				if (line.startsWith("METAHACKATHON_RESULT "))
					observations[revision] = JSON.parse(line.slice("METAHACKATHON_RESULT ".length));
				if (!line.startsWith("METAHACKATHON_TRACE ")) continue;
				const step = rawStepSchema.parse(JSON.parse(line.slice("METAHACKATHON_TRACE ".length)));
				const file = await checkoutFile(input.worktrees[revision].path, step.file);
				const tracked = await runProcess({
					command: "git",
					args: ["ls-files", "--error-unmatch", "--", step.file],
					cwd: input.worktrees[revision].path,
					env: executionEnvironment(),
					timeoutMs: 10_000,
					signal: input.signal,
				});
				if (tracked.exitCode !== 0)
					throw new Error("Trace location is not part of the pinned commit");
				const blob = await runProcess({
					command: "git",
					args: ["show", "--no-ext-diff", "--no-textconv", `${evidence.commitSha}:${step.file}`],
					cwd: input.worktrees[revision].path,
					env: executionEnvironment(),
					timeoutMs: 10_000,
				});
				if (blob.exitCode !== 0 || blob.outputTruncated)
					throw new Error("Trace file is unavailable in the pinned commit");
				const lines = blob.stdout.split("\n");
				if ((await readFile(file, "utf8")) !== blob.stdout)
					throw new Error("Trace source changed after execution");
				if (step.line > lines.length) throw new Error("Trace line is outside source file");
				steps.push({
					id: `${step.id}-${steps.length}`,
					label: step.label,
					location: {
						repository: input.pr.repository,
						revision,
						commitSha: evidence.commitSha,
						path: step.file,
						startLine: step.line,
						endLine: step.line,
					},
					values: step.values,
					outcome: step.outcome === "value" ? ("continue" as const) : step.outcome,
				});
			}
			return ScenarioRunSchema.parse({
				revision,
				commitSha: evidence.commitSha,
				status: result.timedOut
					? "timed-out"
					: result.aborted
						? "cancelled"
						: result.exitCode === 0
							? "completed"
							: "failed",
				steps,
				evidence,
			});
		};
		const before = await run("base");
		const after = await run("head");
		const divergenceIndex = before.steps.findIndex((step, i) => {
			const other = after.steps[i];
			return (
				other &&
				(step.label !== other.label ||
					step.outcome !== other.outcome ||
					JSON.stringify(step.values) !== JSON.stringify(other.values))
			);
		});
		const trace = ScenarioTraceSchema.parse({
			id: randomUUID(),
			prId: input.pr.id,
			title: input.title,
			inputs: input.inputs ?? {},
			before,
			after,
			...(divergenceIndex < 0 ? {} : { divergenceIndex }),
		});
		return { trace, results: { base: observations.base ?? null, head: observations.head ?? null } };
	}
}
