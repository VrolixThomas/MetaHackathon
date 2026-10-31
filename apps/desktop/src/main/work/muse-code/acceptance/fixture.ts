import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type WatchedRepository, type WorkJob, WorkJobSchema } from "../../../../shared/contracts";
import type { CodingTaskInput } from "../../../agent/coding-worker";
import { executionEnvironment } from "../../../runtime/environment";
import { WorkJobRuntime } from "../../../runtime/work-job-runtime";

export const QUESTION = "Which greeting should the fixture return?";
export const ANSWER = "Aurora";
export const REPOSITORY = "muse-acceptance/local-only";
const exec = promisify(execFile);
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export const git = async (cwd: string, ...args: string[]) =>
	(
		await exec(
			"git",
			[
				"--no-replace-objects",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"commit.gpgSign=false",
				...args,
			],
			{
				cwd,
				timeout: 15_000,
				maxBuffer: 100_000,
				env: executionEnvironment({
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_OPTIONAL_LOCKS: "0",
					GIT_AUTHOR_NAME: "Muse acceptance",
					GIT_AUTHOR_EMAIL: "acceptance@example.invalid",
					GIT_COMMITTER_NAME: "Muse acceptance",
					GIT_COMMITTER_EMAIL: "acceptance@example.invalid",
				}),
			}
		)
	).stdout.trim();

export async function createOwnedRoot() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "muse-code-live-acceptance-")));
	const token = randomUUID();
	await writeFile(join(root, "owner.json"), JSON.stringify({ token }), { mode: 0o600, flag: "wx" });
	const stat = await lstat(root);
	return { root, token, device: stat.dev, inode: stat.ino };
}
export type OwnedRoot = Awaited<ReturnType<typeof createOwnedRoot>>;

export async function cleanupFixture(owner: OwnedRoot) {
	const stat = await lstat(owner.root);
	if (
		stat.isSymbolicLink() ||
		stat.dev !== owner.device ||
		stat.ino !== owner.inode ||
		(await realpath(owner.root)) !== owner.root
	)
		throw new Error("Fixture ownership changed");
	const marker = await lstat(join(owner.root, "owner.json"));
	if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || marker.size > 1000)
		throw new Error("Fixture marker changed");
	if (JSON.parse(await readFile(join(owner.root, "owner.json"), "utf8")).token !== owner.token)
		throw new Error("Fixture token changed");
	const fixture = join(owner.root, "fixture");
	const child = await lstat(fixture);
	if (!child.isDirectory() || child.isSymbolicLink()) throw new Error("Fixture directory changed");
	// Never remove the report, a user checkout, CLI auth/session bookkeeping or anything outside this owned child.
	await rm(fixture, { recursive: true });
}

export async function createFixture(owner: OwnedRoot) {
	const root = join(owner.root, "fixture");
	const source = join(root, "source");
	await mkdir(source, { recursive: true, mode: 0o700 });
	const files = {
		"greeting.cjs": 'module.exports = () => "TODO";\n',
		"check.cjs":
			'const assert = require("node:assert/strict");\nassert.equal(require("./greeting.cjs")(), "Hello, Aurora!");\nconsole.log("actual greeting check passed");\n',
		"package.json": JSON.stringify({
			private: true,
			packageManager: "bun@1.3.9",
			scripts: { test: "node check.cjs" },
		}),
		"README.md":
			"Local acceptance fixture only. No remote service exists for this repository identity. Implement only greeting.cjs; never edit check.cjs, package.json, README.md or AGENTS.md. Do not install anything, commit, push, post or access credentials.\n",
		"AGENTS.md":
			"Only greeting.cjs may change for the greeting task. Ask the requested single question using request_user_input before editing. The cancellation task may create cancel-started.txt and cancel-finished.txt only. Do not create background or detached processes. Do not edit validation or configuration.\n",
	};
	for (const [name, text] of Object.entries(files)) await writeFile(join(source, name), text);
	await git(source, "init", "--initial-branch=trunk", "--template=");
	await git(source, "remote", "add", "origin", `https://github.com/${REPOSITORY}.git`);
	await git(source, "config", "user.name", "Muse acceptance");
	await git(source, "config", "user.email", "acceptance@example.invalid");
	await git(source, "add", ".");
	await git(source, "commit", "-m", "Local acceptance baseline");
	const base = await git(source, "rev-parse", "HEAD");
	const repository: WatchedRepository = {
		id: "local-acceptance",
		repository: REPOSITORY,
		localPath: source,
		defaultBranch: "trunk",
		addedAt: new Date().toISOString(),
		linearTeamIds: [],
		linearProjectIds: [],
	};
	const runtime = new WorkJobRuntime({
		directory: join(root, "owned"),
		getToken: async () => {
			throw new Error("Acceptance must never request GitHub credentials");
		},
	});
	const snapshot = async () =>
		hash(
			JSON.stringify({
				head: await git(source, "rev-parse", "HEAD"),
				refs: await git(source, "show-ref"),
				status: await git(source, "status", "--porcelain"),
				files: await Promise.all(
					[...Object.keys(files), ".git/index", ".git/config"].map(async (name) => [
						name,
						hash(await readFile(join(source, name))),
					])
				),
			})
		);
	const original = await snapshot();
	const prepare = async (kind: "greeting" | "cancel", musePath: string | null) => {
		const job = WorkJobSchema.parse({
			id: `${owner.token}-${kind}`,
			codingProvider: { provider: "muse-code", musePath },
			ticket: null,
			repositoryId: repository.id,
			repository: REPOSITORY,
			state: "running",
			branch: `muse/acceptance-${kind}`,
			worktreePath: null,
			baseSha: null,
			headSha: null,
			brief:
				kind === "greeting"
					? `Ask exactly one question via request_user_input: ${QUESTION} Offer Aurora and another name as options. Do not edit any files before the coordinator answers. After the explicit answer, implement greeting.cjs so it returns Hello, <answer>! exactly. Only greeting.cjs may change. Do not run validation yourself; main runs its independent check.`
					: 'Cancellation acceptance: write cancel-started.txt containing started, then use one foreground bash command to run node -e "setTimeout(() => {}, 30000)". Only after that command completes write cancel-finished.txt containing finished. Do not create detached/background work or modify any other file. Main will cancel the turn while it waits.',
			summary: "",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			decisions: [],
			checks: [],
			changedFiles: [],
			pullRequest: null,
			error: null,
		});
		const prepared: WorkJob = {
			...job,
			...(await runtime.prepare(repository, job, new AbortController().signal)),
		};
		const input: CodingTaskInput = {
			jobId: job.id,
			ticket: null,
			repository: REPOSITORY,
			worktreePath: prepared.worktreePath as string,
			brief: job.brief,
			checkpointPath: join(root, "checkpoints", `${kind}.json`),
		};
		return { job: prepared, input };
	};
	return { root, source, files, runtime, prepare, original, snapshot, base };
}
