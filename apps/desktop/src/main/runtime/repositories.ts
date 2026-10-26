import { randomUUID } from "node:crypto";
import {
	link,
	lstat,
	mkdir,
	readFile,
	readdir,
	realpath,
	rename,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { runProcess } from "./process";

export interface PreparedRepository {
	runId: string;
	repositoryPath: string;
	base: { path: string; sha: string };
	head: { path: string; sha: string };
}

export interface PrepareRepositoryOptions {
	repositoryPath?: string;
	cloneUrl?: string;
	prNumber?: number;
	baseRef?: string;
	headRef?: string;
	signal?: AbortSignal;
}

interface OwnershipRecord {
	version: 1;
	runId: string;
	owner: string;
	repositoryPath: string;
	ownedClone: boolean;
	cloneComplete: boolean;
	worktrees: string[];
	refs: string[];
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Keeps user clones intact; its only deletions are registered worktrees and refs under a run UUID. */
export class RepositoryManager {
	private root: string;
	private ownerPromise?: Promise<string>;
	private readonly cleaning = new Set<string>();

	constructor(root: string) {
		this.root = resolve(root);
	}

	/** Searches at most four directory levels, excluding symlinks and generated directories. */
	async findClones(searchRoots: string[]): Promise<string[]> {
		const found = new Set<string>();
		const visited = new Set<string>();
		const excluded = new Set([".git", "node_modules", ".cache", "dist", "build", ".turbo"]);
		let examined = 0;
		const visit = async (path: string, depth: number): Promise<void> => {
			if (depth > 4 || examined++ >= 5000) return;
			let entries: string[];
			try {
				const stat = await lstat(path);
				if (!stat.isDirectory() || stat.isSymbolicLink()) return;
				const canonical = await realpath(path);
				if (visited.has(canonical)) return;
				visited.add(canonical);
				entries = await readdir(canonical);
				if (
					entries.includes(".git") ||
					(entries.includes("HEAD") && entries.includes("objects") && entries.includes("refs"))
				) {
					const result = await runProcess({
						command: "git",
						args: ["rev-parse", "--absolute-git-dir"],
						cwd: canonical,
						env: this.gitEnvironment(),
						timeoutMs: 5000,
					});
					if (result.exitCode === 0) {
						found.add(canonical);
						return;
					}
				}
				for (const entry of entries.sort()) {
					if (!excluded.has(entry) && !entry.startsWith("."))
						await visit(join(canonical, entry), depth + 1);
				}
			} catch {
				// Unreadable or concurrently removed search directories are not clones.
			}
		};
		for (const path of searchRoots) await visit(resolve(path), 0);
		return [...found].sort();
	}

	async prepare(options: PrepareRepositoryOptions): Promise<PreparedRepository> {
		if (Boolean(options.repositoryPath) === Boolean(options.cloneUrl)) {
			throw new Error("Provide exactly one repositoryPath or cloneUrl");
		}
		if (
			options.prNumber !== undefined &&
			(!Number.isSafeInteger(options.prNumber) || options.prNumber <= 0)
		) {
			throw new Error("Invalid pull request number");
		}
		this.validateRef(options.baseRef ?? "HEAD");
		if (options.headRef) this.validateRef(options.headRef);
		if (!options.prNumber && !options.headRef)
			throw new Error("A head revision or PR number is required");
		if (options.cloneUrl) this.validateCloneUrl(options.cloneUrl);
		if (options.signal?.aborted) throw new Error("Repository preparation cancelled");
		const owner = await this.owner();
		const existingRepository = options.repositoryPath
			? await realpath(options.repositoryPath)
			: undefined;
		const runId = randomUUID();
		const runRoot = this.runRoot(runId);
		await mkdir(runRoot);
		const record: OwnershipRecord = {
			version: 1,
			runId,
			owner,
			repositoryPath: existingRepository ?? join(runRoot, "repository"),
			ownedClone: Boolean(options.cloneUrl),
			cloneComplete: false,
			worktrees: [],
			refs: [],
		};
		await this.save(record);
		try {
			if (options.cloneUrl) {
				await mkdir(record.repositoryPath);
				await this.git(
					runRoot,
					["clone", "--no-checkout", "--", options.cloneUrl, record.repositoryPath],
					options.signal,
					120_000
				);
				record.cloneComplete = true;
				await this.save(record);
			}
			await this.git(record.repositoryPath, ["rev-parse", "--absolute-git-dir"], options.signal);
			let baseRef = options.baseRef ?? "HEAD";
			let headRef = options.headRef ?? "HEAD";
			if (options.prNumber) {
				const refRoot = `refs/metahackathon/${runId}`;
				record.refs = [`${refRoot}/base`, `${refRoot}/head`];
				await this.save(record);
				await this.git(
					record.repositoryPath,
					[
						"fetch",
						"--no-tags",
						"--",
						"origin",
						`${baseRef}:${record.refs[0]}`,
						`refs/pull/${options.prNumber}/head:${record.refs[1]}`,
					],
					options.signal,
					120_000
				);
				baseRef = record.refs[0] ?? "";
				headRef = record.refs[1] ?? "";
			}
			const baseSha = await this.resolveRevision(record.repositoryPath, baseRef, options.signal);
			const headSha = await this.resolveRevision(record.repositoryPath, headRef, options.signal);
			const basePath = join(runRoot, "base");
			const headPath = join(runRoot, "head");
			for (const [path, sha] of [
				[basePath, baseSha],
				[headPath, headSha],
			] as const) {
				record.worktrees.push(path);
				await this.save(record);
				await this.git(
					record.repositoryPath,
					["worktree", "add", "--detach", "--", path, sha],
					options.signal
				);
			}
			return {
				runId,
				repositoryPath: record.repositoryPath,
				base: { path: basePath, sha: baseSha },
				head: { path: headPath, sha: headSha },
			};
		} catch (error) {
			try {
				await this.cleanup(runId);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					`Preparation failed; owned run ${runId} retained for recovery`
				);
			}
			throw error;
		}
	}

	async cleanup(runId: string): Promise<void> {
		if (!RUN_ID.test(runId)) throw new Error("Invalid runtime run ID");
		if (this.cleaning.has(runId)) throw new Error("Runtime run cleanup is already in progress");
		this.cleaning.add(runId);
		try {
			const record = await this.load(runId);
			for (const path of record.worktrees) {
				const stat = await lstat(path).catch(() => undefined);
				if (stat?.isSymbolicLink()) throw new Error("Refusing to remove a replaced worktree");
				if (stat) {
					const dirty = await this.git(path, [
						"status",
						"--porcelain",
						"--untracked-files=all",
						"--ignored",
					]);
					if (dirty) throw new Error(`Owned worktree is dirty; preserving run ${runId}`);
					const common = await this.git(path, [
						"rev-parse",
						"--path-format=absolute",
						"--git-common-dir",
					]);
					const repositoryCommon = await this.git(record.repositoryPath, [
						"rev-parse",
						"--path-format=absolute",
						"--git-common-dir",
					]);
					if (common !== repositoryCommon) throw new Error("Worktree repository ownership changed");
				}
			}
			// Check all trees before removing either version, so dirty runs remain reviewable as a pair.
			for (const path of [...record.worktrees]) {
				const listed = await this.git(record.repositoryPath, [
					"worktree",
					"list",
					"--porcelain",
					"-z",
				]);
				if (listed.split("\0").includes(`worktree ${path}`)) {
					await this.git(record.repositoryPath, ["worktree", "remove", "--", path]);
				} else if (await lstat(path).catch(() => undefined)) {
					throw new Error("Unregistered worktree preserved");
				}
				record.worktrees = record.worktrees.filter((item) => item !== path);
				await this.save(record);
			}
			for (const ref of record.refs)
				await this.git(record.repositoryPath, ["update-ref", "-d", ref]);
			if (record.ownedClone) await this.removeOwnedClone(record);
			await unlink(this.recordPath(runId));
			await rmdir(this.runRoot(runId));
		} finally {
			this.cleaning.delete(runId);
		}
	}

	private async removeOwnedClone(record: OwnershipRecord): Promise<void> {
		const stat = await lstat(record.repositoryPath).catch(() => undefined);
		if (!stat) return;
		if (stat.isSymbolicLink()) throw new Error("Replaced owned clone preserved");
		// Clones are --no-checkout; files beyond .git belong to someone else and must survive.
		if ((await readdir(record.repositoryPath)).some((name) => name !== ".git")) {
			throw new Error("Owned clone contains additional files; preserving it");
		}
		const gitDirectory = join(record.repositoryPath, ".git");
		if ((await lstat(gitDirectory).catch(() => undefined))?.isSymbolicLink())
			throw new Error("Replaced clone Git directory preserved");
		if (record.cloneComplete) {
			const common = await this.git(record.repositoryPath, [
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			]);
			if (common !== gitDirectory) throw new Error("Clone repository ownership changed");
			const trees = await this.git(record.repositoryPath, [
				"worktree",
				"list",
				"--porcelain",
				"-z",
			]);
			if (trees.split("\0").filter((item) => item.startsWith("worktree ")).length !== 1) {
				throw new Error("Owned clone has additional worktrees; preserving it");
			}
		}
		const { rm } = await import("node:fs/promises");
		await rm(gitDirectory, { recursive: true, force: true });
		await rmdir(record.repositoryPath);
	}

	private gitEnvironment(): NodeJS.ProcessEnv {
		const inherited = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
		);
		return { ...inherited, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
	}

	private async git(
		cwd: string,
		args: string[],
		signal?: AbortSignal,
		timeoutMs = 30_000
	): Promise<string> {
		const result = await runProcess({
			command: "git",
			args: ["-c", "core.hooksPath=/dev/null", ...args],
			cwd,
			env: this.gitEnvironment(),
			signal,
			timeoutMs,
		});
		if (result.aborted) throw new Error("Repository operation cancelled");
		if (result.timedOut) throw new Error("Repository operation timed out");
		if (result.exitCode !== 0)
			throw new Error(`Git ${args[0]} operation failed (exit ${result.exitCode})`);
		return result.stdout.trim();
	}

	private async resolveRevision(
		repositoryPath: string,
		revision: string,
		signal?: AbortSignal
	): Promise<string> {
		try {
			const sha = await this.git(
				repositoryPath,
				["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
				signal
			);
			if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("Invalid resolved revision");
			return sha;
		} catch (error) {
			throw new Error("Unable to resolve repository revision", { cause: error });
		}
	}

	private validateRef(ref: string): void {
		if (!ref || ref.startsWith("-") || /[\s:*?\\]/.test(ref) || this.hasControlCharacters(ref))
			throw new Error("Invalid repository revision");
	}

	private validateCloneUrl(url: string): void {
		if (!url || url.startsWith("-") || this.hasControlCharacters(url))
			throw new Error("Invalid clone URL");
		if (/^https?:\/\//.test(url) && (new URL(url).username || new URL(url).password)) {
			throw new Error("Use a credential provider instead of credentials in clone URLs");
		}
		if (
			!isAbsolute(url) &&
			!/^https:\/\//.test(url) &&
			!/^ssh:\/\//.test(url) &&
			!/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(url)
		) {
			throw new Error("Unsupported clone URL");
		}
	}

	private hasControlCharacters(value: string): boolean {
		return [...value].some((character) => character.charCodeAt(0) < 32);
	}

	private owner(): Promise<string> {
		this.ownerPromise ??= (async () => {
			await mkdir(this.root, { recursive: true });
			this.root = await realpath(this.root);
			await mkdir(join(this.root, "runs"), { recursive: true });
			if ((await lstat(join(this.root, "runs"))).isSymbolicLink())
				throw new Error("Runtime runs directory cannot be a symlink");
			const path = join(this.root, ".owner");
			const candidate = randomUUID();
			const temporary = join(this.root, `.owner-${candidate}`);
			await writeFile(temporary, candidate, { flag: "wx", mode: 0o600 });
			try {
				await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "EEXIST") throw error;
				});
			} finally {
				await unlink(temporary);
			}
			if ((await lstat(path)).isSymbolicLink())
				throw new Error("Replaced runtime owner record preserved");
			const owner = await readFile(path, "utf8");
			if (!RUN_ID.test(owner)) throw new Error("Invalid runtime repository owner record");
			return owner;
		})();
		return this.ownerPromise;
	}

	private runRoot(runId: string): string {
		return join(this.root, "runs", runId);
	}
	private recordPath(runId: string): string {
		return join(this.runRoot(runId), "ownership.json");
	}

	private async save(record: OwnershipRecord): Promise<void> {
		const temporary = join(this.runRoot(record.runId), `ownership-${randomUUID()}.json`);
		await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
		await rename(temporary, this.recordPath(record.runId));
	}

	private async load(runId: string): Promise<OwnershipRecord> {
		const owner = await this.owner();
		const runRoot = this.runRoot(runId);
		if ((await lstat(runRoot).catch(() => undefined))?.isSymbolicLink())
			throw new Error("Replaced runtime run preserved");
		const raw = await readFile(this.recordPath(runId), "utf8").catch(() => {
			throw new Error("Unknown runtime run ID");
		});
		const record = JSON.parse(raw) as OwnershipRecord;
		if (
			record.version !== 1 ||
			record.runId !== runId ||
			record.owner !== owner ||
			typeof record.repositoryPath !== "string" ||
			!isAbsolute(record.repositoryPath) ||
			typeof record.ownedClone !== "boolean" ||
			typeof record.cloneComplete !== "boolean" ||
			!Array.isArray(record.worktrees) ||
			!Array.isArray(record.refs)
		) {
			throw new Error("Invalid runtime ownership record");
		}
		if (
			record.worktrees.some(
				(path) => ![join(runRoot, "base"), join(runRoot, "head")].includes(path)
			) ||
			record.refs.some(
				(ref) =>
					![`refs/metahackathon/${runId}/base`, `refs/metahackathon/${runId}/head`].includes(ref)
			)
		) {
			throw new Error("Runtime ownership record points outside its run");
		}
		if (record.ownedClone && record.repositoryPath !== join(runRoot, "repository"))
			throw new Error("Invalid owned clone path");
		return record;
	}
}
