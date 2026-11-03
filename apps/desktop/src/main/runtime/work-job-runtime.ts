import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";
import {
	CommitShaSchema,
	RepositoryPathSchema,
	type WatchedRepository,
	WatchedRepositorySchema,
	type WorkCheck,
	WorkCheckSchema,
	type WorkJob,
	WorkJobSchema,
	type WorkReview,
	WorkReviewSchema,
} from "../../shared/contracts";
import { dependencyFile, setupDependencies } from "./dependency-setup";
import { executionEnvironment } from "./environment";
import { runProcess } from "./process";

const IdentitySchema = z.object({ device: z.number(), inode: z.number() });
const OwnershipSchema = z.strictObject({
	version: z.literal(1),
	id: z.string(),
	branch: z.string(),
	repository: z.string(),
	repositoryId: z.string(),
	baseSha: CommitShaSchema,
	gitDirectory: z.string(),
	treeIdentity: IdentitySchema,
	repositoryIdentity: IdentitySchema,
	gitIdentity: IdentitySchema,
	commitConventionRequired: z.boolean(),
	finalizedHead: CommitShaSchema.nullable(),
	publishedHeadSha: CommitShaSchema.optional(),
	checks: z.array(WorkCheckSchema).max(100),
});
type Ownership = z.infer<typeof OwnershipSchema>;
type ChangedFile = WorkReview["files"][number];

const GIT_OPTIONS = [
	"--no-replace-objects",
	"--literal-pathspecs",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"commit.gpgSign=false",
	"-c",
	"tag.gpgSign=false",
	"-c",
	"core.attributesFile=/dev/null",
	"-c",
	"credential.helper=",
	"-c",
	"protocol.allow=never",
	"-c",
	"gc.auto=0",
	"-c",
	"http.followRedirects=false",
];
const CANCELLED = "Work job operation cancelled";
const GIT_FAILURE = "Work job Git operation failed";
const SOURCE_LIMIT = 300_000;
const COMMIT_CONVENTION =
	"Repository commit hooks require an explicit convention decision before committing";

function cancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error(CANCELLED);
}

function key(id: string): string {
	if (!id || id.length > 4096 || id.includes("\0")) throw new Error("Invalid work job identity");
	return createHash("sha256").update(id).digest("hex");
}

function branchName(branch: string, owned = false): string {
	if (
		branch.length > 250 ||
		!branch ||
		branch.startsWith("-") ||
		Array.from(branch).some(
			(character) =>
				character.charCodeAt(0) <= 32 ||
				character.charCodeAt(0) === 127 ||
				"~^:?*[\\".includes(character)
		) ||
		branch.includes("..") ||
		branch.includes("//") ||
		branch.includes("@{") ||
		branch
			.split("/")
			.some(
				(part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock")
			) ||
		(owned && (!branch.startsWith("muse/") || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch))) ||
		branch === "HEAD"
	)
		throw new Error("Invalid work job branch");
	return branch;
}

/** Creates only real directories, refusing symlink traversal before any write. */
async function directory(path: string, create = false): Promise<void> {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of absolute.slice(current.length).split("/").filter(Boolean)) {
		current = join(current, part);
		let stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw new Error("Could not inspect work job directory");
			return undefined;
		});
		if (!stat && create) {
			await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw new Error("Could not create work job directory");
			});
			stat = await lstat(current);
		}
		if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe work job directory");
	}
}

async function identity(path: string): Promise<z.infer<typeof IdentitySchema>> {
	await directory(path);
	const stat = await lstat(path);
	return { device: stat.dev, inode: stat.ino };
}

async function regularFile(path: string, maximum: number): Promise<Buffer> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
		throw new Error("Unsafe work job file");
	return readFile(path);
}

function originIdentity(origin: string): string {
	const ssh = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(origin);
	if (ssh?.[1]) return ssh[1].toLowerCase();
	try {
		const url = new URL(origin);
		if (
			url.hostname !== "github.com" ||
			!["https:", "ssh:"].includes(url.protocol) ||
			url.password ||
			url.search ||
			url.hash ||
			url.port ||
			(url.username && !(url.protocol === "ssh:" && url.username === "git"))
		)
			throw new Error();
		const name = url.pathname.slice(1).replace(/\.git$/, "");
		if (
			!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) ||
			name.split("/").some((p) => p === "." || p === "..")
		)
			throw new Error();
		return name.toLowerCase();
	} catch {
		throw new Error("Work repository requires a matching credential-free GitHub origin");
	}
}

/** Local Git isolation and check evidence; lifecycle, model work and publication policy belong to main. */
export class WorkJobRuntime {
	private readonly root: string;
	private readonly getToken: () => Promise<string | undefined>;

	constructor(options: { directory: string; getToken: () => Promise<string | undefined> }) {
		if (
			!isAbsolute(options.directory) ||
			options.directory.includes("\0") ||
			resolve(options.directory) === parse(options.directory).root
		)
			throw new Error("An absolute app-owned work directory is required");
		this.root = resolve(options.directory);
		this.getToken = options.getToken;
	}

	async prepare(
		repositoryInput: WatchedRepository,
		job: Pick<WorkJob, "id" | "branch">,
		signal: AbortSignal,
		options?: { baseCommit?: string }
	): Promise<{ worktreePath: string; branch: string; baseSha: string }> {
		cancelled(signal);
		// Do not guess a default branch for migrated connections lacking provider metadata.
		const repository = WatchedRepositorySchema.parse(repositoryInput);
		const defaultBranch = repository.defaultBranch;
		if (!defaultBranch) throw new Error("Repository default branch metadata is required");
		branchName(defaultBranch);
		branchName(job.branch, true);
		const requestedBase =
			options?.baseCommit === undefined ? undefined : CommitShaSchema.parse(options.baseCommit);
		// Validate the user's registration before making even app-owned repository mutations.
		const local =
			repository.localPath === null ? undefined : await this.localRepository(repository, signal);
		if (local && (this.root === local || this.root.startsWith(`${local}/`)))
			throw new Error("Work storage must be outside the registered repository");
		return this.lock(job.id, async (root) => {
			const existing = await lstat(join(root, "ownership.json")).catch(() => undefined);
			if (existing) {
				const record = await this.load(job.id);
				if (
					record.branch !== job.branch ||
					record.repositoryId !== repository.id ||
					record.repository !== repository.repository ||
					(requestedBase && record.baseSha !== requestedBase)
				)
					throw new Error("Work job ownership mismatch");
				await this.assertOwned(record, signal);
				return {
					worktreePath: join(root, "worktree"),
					branch: record.branch,
					baseSha: record.baseSha,
				};
			}
			const bare = join(root, "repository.git");
			if (await lstat(bare).catch(() => undefined))
				throw new Error("Incomplete work job preparation retained for inspection");
			const url = this.url(repository.repository);
			let base = requestedBase;
			let authorName = "Muse";
			let authorEmail = "muse@localhost";
			if (local) {
				if (!base) base = await this.resolveDefault(local, defaultBranch, signal);
				authorName = (await this.config(local, "user.name", signal)) || authorName;
				authorEmail = (await this.config(local, "user.email", signal)) || authorEmail;
				// A private object copy also isolates config, refs and index from the original clone.
				await this.git(
					root,
					[
						"-c",
						"protocol.file.allow=always",
						"clone",
						"--bare",
						"--no-hardlinks",
						"--dissociate",
						"--template=",
						"--",
						local,
						bare,
					],
					signal
				);
			} else {
				await this.network(root, ["clone", "--bare", "--template=", "--", url, bare], signal);
			}
			await this.git(bare, ["config", "--local", "remote.origin.url", url], signal);
			await this.git(bare, ["config", "--local", "user.name", authorName], signal);
			await this.git(bare, ["config", "--local", "user.email", authorEmail], signal);
			if (!base) base = await this.resolveDefault(bare, defaultBranch, signal);
			if (!base || !(await this.revision(bare, base, signal))) {
				const ref = requestedBase ?? `refs/heads/${defaultBranch}`;
				await this.network(
					bare,
					["fetch", "--no-tags", "--no-write-fetch-head", "--", url, `${ref}:refs/muse/base`],
					signal
				);
				base = await this.revision(bare, "refs/muse/base", signal);
			}
			if (!base || (requestedBase && base !== requestedBase))
				throw new Error("Work job base commit is unavailable");
			const tree = join(root, "worktree");
			await this.git(bare, ["worktree", "add", "-b", job.branch, "--", tree, base], signal);
			const gitDirectory = (
				await this.git(tree, ["rev-parse", "--absolute-git-dir"], signal)
			).stdout.trim();
			const record: Ownership = {
				version: 1,
				id: job.id,
				branch: job.branch,
				repository: repository.repository,
				repositoryId: repository.id,
				baseSha: base,
				gitDirectory,
				treeIdentity: await identity(tree),
				repositoryIdentity: await identity(bare),
				gitIdentity: await identity(gitDirectory),
				commitConventionRequired: local ? await this.hasCommitHooks(local, signal) : false,
				finalizedHead: null,
				checks: [],
			};
			await this.save(record);
			cancelled(signal);
			return { worktreePath: tree, branch: job.branch, baseSha: base };
		});
	}

	/** Runs before every coding child, including resumed jobs, under the ownership lock. */
	async bootstrap(jobInput: WorkJob, signal: AbortSignal): Promise<string> {
		const job = WorkJobSchema.parse(jobInput);
		return this.lock(job.id, async (root) => {
			const record = await this.forJob(job, signal);
			const head = await this.head(record, signal);
			const listing = await this.git(
				this.tree(job.id),
				["ls-tree", "-r", "-z", record.baseSha],
				signal,
				false,
				4_000_000
			);
			if (listing.outputTruncated) throw new Error("Dependency baseline exceeds inspection limit");
			const baseline: Record<string, string> = {};
			for (const entry of listing.stdout.split("\0").filter(Boolean)) {
				const match = /^([0-7]+) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
				if (match?.[2] && match[3] && dependencyFile(match[3])) {
					if (match[1] !== "100644" && match[1] !== "100755")
						throw new Error("Unsafe baseline dependency input");
					baseline[match[3]] = match[2];
				}
			}
			return setupDependencies({
				tree: this.tree(job.id),
				directory: root,
				baseline,
				signal,
				ignoredBuildOutput: async (path) => {
					const result = await this.git(
						this.tree(job.id),
						["check-ignore", "--quiet", "--", path],
						signal,
						true
					);
					if (result.exitCode !== 0 && result.exitCode !== 1)
						throw new Error("Could not verify generated build output");
					return result.exitCode === 0;
				},
				verify: async () => {
					await this.forJob(job, signal);
					if ((await this.head(record, signal)) !== head)
						throw new Error("Dependency setup head changed");
				},
			});
		});
	}

	async finalize(
		jobInput: WorkJob,
		signal: AbortSignal
	): Promise<{ headSha: string; changedFiles: string[]; checks: WorkCheck[] }> {
		const job = WorkJobSchema.parse(jobInput);
		return this.lock(job.id, async () => {
			const record = await this.forJob(job, signal);
			record.finalizedHead = null;
			await this.save(record);
			const tree = this.tree(job.id);
			await this.git(tree, ["add", "--all", "--", "."], signal);
			const staged = await this.git(
				tree,
				["diff", "--cached", "--quiet", "--exit-code"],
				signal,
				true
			);
			if (staged.exitCode === 1) {
				if (record.commitConventionRequired || (await this.hasCommitHooks(tree, signal)))
					throw new Error(COMMIT_CONVENTION);
				await this.git(tree, ["commit", "-m", this.commitMessage(job)], signal);
			} else if (staged.exitCode !== 0) throw new Error(GIT_FAILURE);
			const headSha = await this.head(record, signal);
			const changedFiles = (await this.changes(record, headSha, signal)).map((file) => file.path);
			record.checks = [];
			await this.save(record);
			const commands = await this.checkCommands(record, signal);
			const root = this.jobRoot(job.id);
			for (const name of ["home", "tmp"]) await directory(join(root, name), true);
			for (const command of commands) {
				cancelled(signal);
				await this.assertClean(record, headSha, signal);
				const id = randomUUID();
				const startedAt = new Date().toISOString();
				let output: string;
				let exitCode: number;
				try {
					const result = await runProcess({
						command: command.command,
						args: command.args,
						cwd: tree,
						signal,
						// Repository-wide suites can outlast a foreground command budget.
						timeoutMs: command.args[1]?.startsWith("test") ? 600_000 : 120_000,
						maxOutputBytes: 64_000,
						env: this.environment({
							MUSE_WORK_HOME: join(root, "home"),
							npm_config_cache: join(root, "home", "npm-cache"),
							npm_config_userconfig: "/dev/null",
							XDG_CACHE_HOME: join(root, "home", "cache"),
							YARN_CACHE_FOLDER: join(root, "home", "yarn-cache"),
							BUN_INSTALL_CACHE_DIR: join(root, "home", "bun-cache"),
							TMPDIR: join(root, "tmp"),
							CI: "1",
						}),
					});
					exitCode = result.aborted ? 130 : result.timedOut ? 124 : (result.exitCode ?? 1);
					output = `${result.stdout}${result.stderr}${result.outputTruncated ? "\n[Output truncated]\n" : ""}${result.aborted ? "\n[Check cancelled]\n" : result.timedOut ? "\n[Check timed out]\n" : ""}`;
				} catch {
					exitCode = 127;
					output = "Validation command could not be started\n";
				}
				await directory(join(this.root, "logs"), true);
				await writeFile(join(this.root, "logs", `${id}.log`), output, { mode: 0o600, flag: "wx" });
				record.checks.push(
					WorkCheckSchema.parse({
						id,
						...command,
						commitSha: headSha,
						startedAt,
						finishedAt: new Date().toISOString(),
						exitCode,
						logId: id,
					})
				);
				await this.save(record);
				cancelled(signal);
				await this.assertClean(record, headSha, signal);
			}
			await this.assertClean(record, headSha, signal);
			record.finalizedHead = headSha;
			await this.save(record);
			return { headSha, changedFiles, checks: record.checks };
		});
	}

	async review(jobInput: WorkJob, signal?: AbortSignal): Promise<WorkReview> {
		const job = WorkJobSchema.parse(jobInput);
		return this.lock(job.id, async () => {
			const record = await this.forJob(job, signal);
			const head = await this.head(record, signal);
			if (!job.headSha || head !== job.headSha) throw new Error("Work job review head is stale");
			const files: ChangedFile[] = [];
			for (const file of await this.changes(record, head, signal)) {
				const base = await this.source(record, record.baseSha, file.oldPath ?? file.path, signal);
				const after = await this.source(record, head, file.path, signal);
				const diff = await this.git(
					this.tree(job.id),
					[
						"diff",
						"--no-ext-diff",
						"--no-textconv",
						"--no-color",
						"--find-renames",
						"--unified=3",
						record.baseSha,
						head,
						"--",
						...new Set([file.oldPath ?? file.path, file.path]),
					],
					signal,
					false,
					110_000
				);
				const patch =
					diff.outputTruncated ||
					diff.stdout.length > 100_000 ||
					base.status === "binary" ||
					after.status === "binary"
						? null
						: diff.stdout;
				files.push({ path: file.path, status: file.status, patch, base, head: after });
			}
			cancelled(signal);
			return WorkReviewSchema.parse({ job, files });
		});
	}

	async push(
		jobInput: WorkJob,
		repositoryInput: WatchedRepository,
		signal: AbortSignal,
		targetBranch?: string
	): Promise<void> {
		const job = WorkJobSchema.parse(jobInput);
		const repository = WatchedRepositorySchema.parse(repositoryInput);
		if (repository.localPath !== null) await this.localRepository(repository, signal);
		await this.lock(job.id, async (root) => {
			const record = await this.forJob(job, signal);
			if (repository.id !== record.repositoryId || repository.repository !== record.repository)
				throw new Error("Work job repository mismatch");
			const head = await this.head(record, signal);
			if (head !== job.headSha) throw new Error("Work job publication head is stale");
			if (record.finalizedHead !== head) throw new Error("Work job finalization is incomplete");
			if (record.checks.some((check) => check.commitSha !== head || check.exitCode !== 0))
				throw new Error("Work job checks have not passed");
			await this.assertClean(record, head, signal);
			const target = branchName(targetBranch ?? job.branch, targetBranch === undefined);
			if (
				(job.feedback && targetBranch === undefined) ||
				(targetBranch !== undefined &&
					(!job.feedback ||
						!job.pullRequest ||
						job.feedback.prId !== job.pullRequest.id ||
						job.pullRequest.repository !== repository.repository ||
						(job.pullRequest.headSha !== record.baseSha &&
							job.pullRequest.headSha !== record.publishedHeadSha)))
			)
				throw new Error("Feedback publication requires the current pull request head");
			const ref = `refs/heads/${target}`;
			const expected =
				record.publishedHeadSha ?? (targetBranch === undefined ? "0".repeat(40) : record.baseSha);
			const url = this.url(repository.repository);
			const remote = (
				await this.network(this.tree(job.id), ["ls-remote", "--refs", "--", url, ref], signal)
			).stdout.trim();
			if (remote === `${head}\t${ref}`) {
				record.publishedHeadSha = head;
				await this.save(record);
				return;
			}
			if ((remote ? remote.split("\t")[0] : "0".repeat(40)) !== expected)
				throw new Error("Remote branch changed; refresh before publishing");
			// Ordinary push checks the server's advertised old SHA. This private hook additionally
			// rejects a changed advertisement between ls-remote and push; server CAS covers later races.
			const hooks = join(root, `push-${randomUUID()}`);
			await directory(hooks, true);
			try {
				await writeFile(
					join(hooks, "pre-push"),
					`#!/bin/sh\nwhile read -r local_ref local_sha remote_ref remote_sha; do\n  [ "$remote_ref" = '${ref.replaceAll("'", "'\\''")}' ] && [ "$remote_sha" = '${expected}' ] || exit 1\ndone\n`,
					{ mode: 0o700, flag: "wx" }
				);
				await this.network(
					this.tree(job.id),
					[
						"-c",
						`core.hooksPath=${hooks}`,
						"push",
						"--no-force",
						"--no-follow-tags",
						"--recurse-submodules=no",
						"--",
						url,
						`${head}:${ref}`,
					],
					signal
				);
				record.publishedHeadSha = head;
				await this.save(record);
			} finally {
				await rm(hooks, { recursive: true, force: true });
			}
		});
	}

	/** Bounded command output is stored separately from job metadata, without provider credentials. */
	async getLog(logId: string): Promise<string> {
		if (!/^[a-f0-9-]{36}$/.test(logId)) throw new Error("Invalid work log identity");
		await directory(join(this.root, "logs"));
		return (await regularFile(join(this.root, "logs", `${logId}.log`), 65_000)).toString("utf8");
	}

	/** Includes completed and interrupted checks even when finalize rejected after cancellation. */
	async getChecks(jobId: string): Promise<WorkCheck[]> {
		const record = await this.load(jobId);
		return record.checks;
	}

	private jobRoot(id: string): string {
		return join(this.root, "jobs", key(id));
	}
	private tree(id: string): string {
		return join(this.jobRoot(id), "worktree");
	}
	private url(repository: string): string {
		return `https://github.com/${repository}.git`;
	}

	private environment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
		return executionEnvironment({
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_NO_LAZY_FETCH: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_OPTIONAL_LOCKS: "0",
			...extra,
		});
	}

	private async git(
		cwd: string,
		args: string[],
		signal?: AbortSignal,
		allowFailure = false,
		maximum = 1_000_000,
		extra: Record<string, string> = {}
	) {
		cancelled(signal);
		try {
			const result = await runProcess({
				command: "git",
				args: [
					...GIT_OPTIONS,
					...(args[0] === "commit" ? [] : ["-c", "core.hooksPath=/dev/null"]),
					...args,
				],
				cwd,
				signal,
				env: this.environment(extra),
				timeoutMs: 120_000,
				maxOutputBytes: maximum,
			});
			cancelled(signal);
			if (result.timedOut || result.aborted || (result.exitCode !== 0 && !allowFailure))
				throw new Error(GIT_FAILURE);
			return result;
		} catch {
			throw new Error(signal?.aborted ? CANCELLED : GIT_FAILURE);
		}
	}

	private async network(cwd: string, args: string[], signal: AbortSignal) {
		cancelled(signal);
		await directory(join(this.root, "credentials"), true);
		const privateDirectory = join(this.root, "credentials", randomUUID());
		await directory(privateDirectory, true);
		try {
			let token: string | undefined;
			try {
				token = await this.getToken();
			} catch {
				throw new Error("GitHub credentials are unavailable");
			}
			cancelled(signal);
			const helper = join(privateDirectory, "askpass");
			await writeFile(join(privateDirectory, "token"), token ?? "", { mode: 0o600, flag: "wx" });
			await writeFile(
				helper,
				'#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" x-access-token ;;\n  *Password*) cat "$(dirname "$0")/token" ;;\n  *) exit 1 ;;\nesac\n',
				{ mode: 0o700, flag: "wx" }
			);
			return await this.git(
				cwd,
				["-c", "protocol.https.allow=always", ...args],
				signal,
				false,
				1_000_000,
				{ GIT_ASKPASS: helper, GCM_INTERACTIVE: "Never" }
			);
		} finally {
			await rm(privateDirectory, { recursive: true, force: true });
		}
	}

	private async lock<T>(id: string, action: (root: string) => Promise<T>): Promise<T> {
		const root = this.jobRoot(id);
		await directory(root, true);
		const path = join(root, "operation.lock");
		const lock = await this.acquireLock(path);
		const claimed = await lock.stat();
		try {
			await lock.writeFile(JSON.stringify({ pid: process.pid }));
			return await action(root);
		} finally {
			await lock.close();
			await this.releaseLock(root, path, claimed);
		}
	}

	private async releaseLock(
		root: string,
		path: string,
		claimed: { dev: number; ino: number }
	): Promise<void> {
		await directory(root);
		const current = await lstat(path);
		if (current.dev !== claimed.dev || current.ino !== claimed.ino || current.isSymbolicLink())
			throw new Error("Work job lock identity changed");
		await rm(path);
	}

	private async acquireLock(path: string) {
		const message = "Work job operation is already active or its lock needs inspection";
		try {
			return await open(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(message);
		}
		// A dead owner is recoverable on reopen. A live or ambiguous PID is retained conservatively.
		let owner: { pid: number };
		try {
			owner = z
				.object({ pid: z.int().positive() })
				.parse(JSON.parse((await regularFile(path, 1024)).toString("utf8")));
		} catch {
			throw new Error(message);
		}
		try {
			process.kill(owner.pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				await rm(path);
				return open(path, "wx", 0o600).catch(() => {
					throw new Error(message);
				});
			}
		}
		throw new Error(message);
	}

	private async load(id: string): Promise<Ownership> {
		await directory(this.jobRoot(id));
		const record = OwnershipSchema.parse(
			JSON.parse(
				(await regularFile(join(this.jobRoot(id), "ownership.json"), 200_000)).toString("utf8")
			)
		);
		if (record.id !== id) throw new Error("Work job ownership mismatch");
		return record;
	}

	private async save(record: Ownership): Promise<void> {
		const root = this.jobRoot(record.id);
		await directory(root);
		const temporary = join(root, `ownership-${randomUUID()}.json`);
		await writeFile(temporary, JSON.stringify(OwnershipSchema.parse(record)), {
			mode: 0o600,
			flag: "wx",
		});
		await rename(temporary, join(root, "ownership.json"));
	}

	private async localRepository(
		repository: WatchedRepository,
		signal: AbortSignal
	): Promise<string> {
		const path = repository.localPath;
		if (!path || !isAbsolute(path) || path.includes("\0"))
			throw new Error("A canonical registered repository path is required");
		await directory(path);
		if (
			(await realpath(path)) !== path ||
			(await this.git(path, ["rev-parse", "--show-toplevel"], signal)).stdout.trim() !== path
		)
			throw new Error("Registered repository path is no longer canonical");
		const origin = await this.config(path, "remote.origin.url", signal);
		if (originIdentity(origin) !== repository.repository.toLowerCase())
			throw new Error("Work repository origin does not match registration");
		return path;
	}

	private async config(cwd: string, name: string, signal: AbortSignal): Promise<string> {
		const result = await this.git(
			cwd,
			["config", "--local", "--no-includes", "--get", name],
			signal,
			true,
			16_000
		);
		if (result.outputTruncated || (result.exitCode !== 0 && result.exitCode !== 1))
			throw new Error(GIT_FAILURE);
		return result.exitCode === 0 ? result.stdout.trim() : "";
	}

	private async hasCommitHooks(cwd: string, signal: AbortSignal): Promise<boolean> {
		const names = (
			await this.git(cwd, ["config", "--local", "--no-includes", "--name-only", "--list"], signal)
		).stdout.split("\n");
		if (names.some((name) => name.startsWith("include.") || name.startsWith("includeif.")))
			return true;
		const configured = await this.config(cwd, "core.hooksPath", signal);
		if (configured) return configured !== "/dev/null";
		const common = (
			await this.git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)
		).stdout.trim();
		for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
			const stat = await lstat(join(common, "hooks", name)).catch(
				(error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw new Error(COMMIT_CONVENTION);
					return undefined;
				}
			);
			if (stat && (stat.isSymbolicLink() || (stat.mode & 0o111) !== 0)) return true;
		}
		return false;
	}

	private async revision(
		cwd: string,
		ref: string,
		signal?: AbortSignal
	): Promise<string | undefined> {
		const result = await this.git(
			cwd,
			["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
			signal,
			true
		);
		return result.exitCode === 0 ? CommitShaSchema.parse(result.stdout.trim()) : undefined;
	}

	private async resolveDefault(
		cwd: string,
		branch: string,
		signal: AbortSignal
	): Promise<string | undefined> {
		return (
			(await this.revision(cwd, `refs/remotes/origin/${branch}`, signal)) ??
			(await this.revision(cwd, `refs/heads/${branch}`, signal))
		);
	}

	private async assertOwned(record: Ownership, signal?: AbortSignal): Promise<void> {
		branchName(record.branch, true);
		const tree = this.tree(record.id);
		const bare = join(this.jobRoot(record.id), "repository.git");
		if (record.gitDirectory !== join(bare, "worktrees", "worktree"))
			throw new Error("Work job Git directory escaped ownership");
		for (const [path, expected] of [
			[tree, record.treeIdentity],
			[bare, record.repositoryIdentity],
			[record.gitDirectory, record.gitIdentity],
		] as const) {
			const actual = await identity(path);
			if (actual.device !== expected.device || actual.inode !== expected.inode)
				throw new Error("Work job directory identity changed");
		}
		const pointer = (await regularFile(join(tree, ".git"), 8192)).toString("utf8").trim();
		if (pointer !== `gitdir: ${record.gitDirectory}`)
			throw new Error("Work job Git identity changed");
		await regularFile(join(bare, "config"), 64_000);
		const common = (await regularFile(join(record.gitDirectory, "commondir"), 8192))
			.toString("utf8")
			.trim();
		if (resolve(record.gitDirectory, common) !== bare)
			throw new Error("Work job common Git directory changed");
		await regularFile(join(record.gitDirectory, "HEAD"), 1024);
		await directory(join(bare, "refs", "heads", ...record.branch.split("/").slice(0, -1)));
		await regularFile(join(bare, "refs", "heads", record.branch), 1024);
		// Local configuration is deliberately small: forbid includes, filters and URL rewrites.
		const configuration = await this.git(
			bare,
			["config", "--local", "--no-includes", "--null", "--list"],
			signal,
			false,
			64_000
		);
		const allowed = new Set([
			"core.repositoryformatversion",
			"core.filemode",
			"core.bare",
			"core.logallrefupdates",
			"core.ignorecase",
			"core.precomposeunicode",
			"core.hookspath",
			"remote.origin.url",
			"remote.origin.fetch",
			"user.name",
			"user.email",
		]);
		if (
			configuration.outputTruncated ||
			configuration.stdout
				.split("\0")
				.filter(Boolean)
				.some((entry) => !allowed.has(entry.split("\n")[0] ?? ""))
		)
			throw new Error("Unsafe work job Git configuration");
		await directory(join(bare, "objects"));
		for (const entry of await readdir(join(bare, "objects"), { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.isSymbolicLink())
				throw new Error("Unsafe work job Git object directory");
			const path = join(bare, "objects", entry.name);
			await directory(path);
			if (
				(await readdir(path, { withFileTypes: true })).some(
					(child) =>
						child.isSymbolicLink() ||
						!child.isFile() ||
						(entry.name === "info" && child.name === "alternates")
				)
			)
				throw new Error("Unsafe work job Git objects");
		}
		if (
			(await this.git(tree, ["symbolic-ref", "--quiet", "HEAD"], signal)).stdout.trim() !==
			`refs/heads/${record.branch}`
		)
			throw new Error("Work job branch identity changed");
		if (
			originIdentity(
				(
					await this.git(
						tree,
						["config", "--local", "--no-includes", "--get", "remote.origin.url"],
						signal
					)
				).stdout.trim()
			) !== record.repository.toLowerCase()
		)
			throw new Error("Work job origin changed");
		cancelled(signal);
	}

	private async forJob(job: WorkJob, signal?: AbortSignal): Promise<Ownership> {
		cancelled(signal);
		const record = await this.load(job.id);
		if (
			job.worktreePath !== this.tree(job.id) ||
			job.branch !== record.branch ||
			job.repository !== record.repository ||
			job.repositoryId !== record.repositoryId ||
			job.baseSha !== record.baseSha
		)
			throw new Error("Work job ownership mismatch");
		await this.assertOwned(record, signal);
		return record;
	}

	private async head(record: Ownership, signal?: AbortSignal): Promise<string> {
		const sha = await this.revision(this.tree(record.id), "HEAD", signal);
		if (
			!sha ||
			(
				await this.git(
					this.tree(record.id),
					["merge-base", "--is-ancestor", record.baseSha, sha],
					signal,
					true
				)
			).exitCode !== 0
		)
			throw new Error("Work job head no longer descends from its prepared base");
		return sha;
	}

	private async assertClean(record: Ownership, head: string, signal?: AbortSignal): Promise<void> {
		await this.assertOwned(record, signal);
		if (
			(await this.head(record, signal)) !== head ||
			(
				await this.git(
					this.tree(record.id),
					["status", "--porcelain=v1", "--untracked-files=normal"],
					signal
				)
			).stdout
		)
			throw new Error(
				"Validation changed the committed work; finalize again before review or publication"
			);
	}

	private commitMessage(job: WorkJob): string {
		const title = job.ticket
			? `${job.ticket.identifier}: ${job.ticket.title}`
			: job.feedback
				? `Address review feedback: ${job.feedback.body}`
				: `Muse: ${job.brief}`;
		const clean = Array.from(title, (character) =>
			character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character
		).join("");
		return clean.slice(0, 180) + (job.feedback ? `\n\nFeedback: ${job.feedback.url}` : "");
	}

	private async changes(record: Ownership, head: string, signal?: AbortSignal) {
		const diff = await this.git(
			this.tree(record.id),
			[
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--name-status",
				"-z",
				"--find-renames",
				record.baseSha,
				head,
				"--",
			],
			signal
		);
		if (diff.outputTruncated)
			throw new Error("Work job changed-file listing exceeds review limits");
		const fields = diff.stdout.split("\0");
		fields.pop();
		const files: { path: string; oldPath?: string; status: string }[] = [];
		while (fields.length) {
			const status = fields.shift();
			const first = RepositoryPathSchema.max(4096).parse(fields.shift());
			if (status?.startsWith("R"))
				files.push({
					oldPath: first,
					path: RepositoryPathSchema.max(4096).parse(fields.shift()),
					status: "renamed",
				});
			else
				files.push({
					path: first,
					status:
						status === "A"
							? "added"
							: status === "D"
								? "removed"
								: status === "T"
									? "type-changed"
									: "modified",
				});
			if (files.length > 300) throw new Error("Work job exceeds the changed-file review limit");
		}
		return files;
	}

	private async source(
		record: Ownership,
		sha: string,
		path: string,
		signal?: AbortSignal
	): Promise<ChangedFile["base"]> {
		RepositoryPathSchema.max(4096).parse(path);
		const tree = this.tree(record.id);
		const entry = (await this.git(tree, ["ls-tree", "-z", sha, "--", path], signal)).stdout;
		if (!entry) return { path, commitSha: sha, status: "missing", content: null };
		const match = /^([0-7]+) blob ([a-f0-9]{40})\t([\s\S]*)\0$/.exec(entry);
		if (!match || match[3] !== path)
			return { path, commitSha: sha, status: "binary", content: null };
		const size = Number(
			(await this.git(tree, ["cat-file", "-s", match[2] as string], signal)).stdout.trim()
		);
		if (!Number.isSafeInteger(size) || size < 0) throw new Error(GIT_FAILURE);
		if (size > SOURCE_LIMIT) return { path, commitSha: sha, status: "too-large", content: null };
		// This builtin reads a blob only: no shell, filters, hooks or child process transport.
		const bytes = await new Promise<Buffer>((resolveBytes, reject) => {
			execFile(
				"git",
				[...GIT_OPTIONS, "cat-file", "blob", match[2] as string],
				{
					cwd: tree,
					signal,
					encoding: "buffer",
					timeout: 10_000,
					maxBuffer: SOURCE_LIMIT + 1,
					env: this.environment(),
				},
				(error, stdout) =>
					error
						? reject(new Error(signal?.aborted ? CANCELLED : GIT_FAILURE))
						: resolveBytes(stdout)
			);
		});
		if (bytes.length !== size) throw new Error(GIT_FAILURE);
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			return { path, commitSha: sha, status: "binary", content: null };
		}
		if (content.includes("\0")) return { path, commitSha: sha, status: "binary", content: null };
		return { path, commitSha: sha, status: "available", content };
	}

	private async checkCommands(
		record: Ownership,
		signal: AbortSignal
	): Promise<{ command: string; args: string[] }[]> {
		const source = await this.source(record, record.baseSha, "package.json", signal);
		if (source.status !== "available" || source.content === null) return [];
		let pkg: { scripts?: Record<string, unknown>; packageManager?: unknown };
		try {
			pkg = JSON.parse(source.content);
		} catch {
			throw new Error("Repository baseline package manifest is invalid");
		}
		if (!pkg || typeof pkg !== "object" || !pkg.scripts || typeof pkg.scripts !== "object")
			return [];
		let manager =
			typeof pkg.packageManager === "string"
				? /^(bun|npm|pnpm|yarn)@/.exec(pkg.packageManager)?.[1]
				: undefined;
		if (!manager) {
			const names = (
				await this.git(
					this.tree(record.id),
					["ls-tree", "--name-only", record.baseSha, "--"],
					signal
				)
			).stdout.split("\n");
			manager =
				names.includes("bun.lock") || names.includes("bun.lockb")
					? "bun"
					: names.includes("pnpm-lock.yaml")
						? "pnpm"
						: names.includes("yarn.lock")
							? "yarn"
							: "npm";
		}
		const names = [
			typeof pkg.scripts["type-check"] === "string" ? "type-check" : "typecheck",
			"lint",
			...(typeof pkg.scripts["test"] === "string" ? ["test"] : ["test:unit", "test:contracts"]),
			"build",
		];
		if (
			names.every((name) => typeof pkg.scripts?.[name] !== "string") &&
			typeof pkg.scripts["check"] === "string"
		)
			names.push("check");
		return names
			.filter((name) => typeof pkg.scripts?.[name] === "string" && String(pkg.scripts[name]).trim())
			.map((name) => ({ command: manager, args: ["run", name] })) as {
			command: string;
			args: string[];
		}[];
	}
}
