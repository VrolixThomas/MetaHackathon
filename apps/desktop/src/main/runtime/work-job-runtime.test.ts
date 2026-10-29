import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
	type WatchedRepository,
	type WorkJob,
	WorkJobSchema,
	WorkReviewSchema,
} from "../../shared/contracts";
import { WorkJobRuntime } from "./work-job-runtime";

const exec = promisify(execFile);
const signal = () => new AbortController().signal;
const gitEnvironment = {
	PATH: process.env["PATH"],
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_OPTIONAL_LOCKS: "0",
	GIT_AUTHOR_NAME: "Local tester",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "Local tester",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
};
async function git(cwd: string, ...args: string[]): Promise<string> {
	return (
		await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
			cwd,
			env: gitEnvironment,
		})
	).stdout.trim();
}

async function fixture(
	work: (f: {
		root: string;
		source: string;
		owned: string;
		base: string;
		repository: WatchedRepository;
		runtime: WorkJobRuntime;
		job: WorkJob;
		prepare: () => Promise<WorkJob>;
	}) => Promise<void>,
	scripts?: Record<string, string>,
	validation = "console.log('real local check');\n"
) {
	const temporary = await mkdtemp(join(tmpdir(), "muse-job-runtime-"));
	const root = await realpath(temporary);
	const source = join(root, "user-repository");
	const owned = join(root, "app-owned");
	await mkdir(source);
	try {
		await git(source, "init", "--initial-branch=trunk", "--template=");
		await git(
			source,
			"remote",
			"add",
			"origin",
			"git@github.com:actual-owner/actual-repository.git"
		);
		await git(source, "config", "user.name", "Repository Author");
		await git(source, "config", "user.email", "author@example.invalid");
		await writeFile(join(source, "source.txt"), "first line\r\nsecond line\r\n");
		if (scripts) {
			await writeFile(
				join(source, "package.json"),
				JSON.stringify({ scripts, packageManager: "bun@1.3.9" })
			);
			await writeFile(join(source, "validate.cjs"), validation);
		}
		await git(source, "add", ".");
		await git(source, "commit", "-m", "Actual baseline");
		const base = await git(source, "rev-parse", "HEAD");
		const repository: WatchedRepository = {
			id: "registered-repository",
			repository: "actual-owner/actual-repository",
			localPath: source,
			defaultBranch: "trunk",
			addedAt: new Date().toISOString(),
			linearTeamIds: [],
			linearProjectIds: [],
		};
		const job = WorkJobSchema.parse({
			id: "job-local-1",
			ticket: null,
			repositoryId: repository.id,
			repository: repository.repository,
			state: "running",
			branch: "muse/local-job-1",
			worktreePath: null,
			baseSha: null,
			headSha: null,
			brief: "Improve the actual source",
			summary: "",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			decisions: [],
			checks: [],
			changedFiles: [],
			pullRequest: null,
			error: null,
		});
		const runtime = new WorkJobRuntime({
			directory: owned,
			getToken: async () => {
				throw new Error("Local tests must never request network credentials");
			},
		});
		const prepare = async () => ({ ...job, ...(await runtime.prepare(repository, job, signal())) });
		await work({ root, source, owned, base, repository, runtime, job, prepare });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("prepares independent real worktree and commits while preserving user's dirty tree, HEAD, index, refs and config", async () => {
	await fixture(async ({ source, runtime, prepare, base }) => {
		await git(source, "switch", "-c", "user-feature");
		await writeFile(join(source, "feature-only.txt"), "committed on the user's branch only\n");
		await git(source, "add", "feature-only.txt");
		await git(source, "commit", "-m", "User feature differs from actual default branch");
		await writeFile(join(source, "source.txt"), "staged user work\n");
		await git(source, "add", "source.txt");
		await writeFile(join(source, "source.txt"), "unstaged user work\n");
		await writeFile(join(source, "untracked.txt"), "user untracked\n");
		const snapshot = async () => ({
			head: await git(source, "rev-parse", "HEAD"),
			branch: await git(source, "branch", "--show-current"),
			index: await readFile(join(source, ".git", "index")),
			refs: await git(source, "show-ref"),
			config: await readFile(join(source, ".git", "config")),
			status: await git(source, "status", "--porcelain"),
			content: await readFile(join(source, "source.txt")),
			untracked: await readFile(join(source, "untracked.txt")),
		});
		const before = await snapshot();
		const job = await prepare();
		assert.equal(job.baseSha, base);
		assert.notEqual(job.worktreePath, source);
		const tree = job.worktreePath as string;
		assert.equal(await lstat(join(tree, "feature-only.txt")).catch(() => undefined), undefined);
		assert.equal(await readFile(join(tree, "source.txt"), "utf8"), "first line\r\nsecond line\r\n");
		await writeFile(join(tree, "source.txt"), "first line\r\nactual independent edit\r\n");
		const result = await runtime.finalize(job, signal());
		assert.notEqual(result.headSha, base);
		assert.deepEqual(result.changedFiles, ["source.txt"]);
		assert.deepEqual(result.checks, []);
		assert.equal(
			await git(tree, "show", "-s", "--format=%an <%ae>"),
			"Repository Author <author@example.invalid>"
		);
		assert.equal(await git(tree, "status", "--porcelain"), "");
		assert.deepEqual(await snapshot(), before);
		const review = WorkReviewSchema.parse(await runtime.review({ ...job, ...result }));
		assert.equal(review.files.length, 1);
		assert.equal(review.files[0]?.base.content, "first line\r\nsecond line\r\n");
		assert.equal(review.files[0]?.head.content, "first line\r\nactual independent edit\r\n");
		assert.equal(review.files[0]?.base.commitSha, base);
		assert.equal(review.files[0]?.head.commitSha, result.headSha);
		assert.match(review.files[0]?.patch ?? "", /actual independent edit/);
		assert.equal("prId" in (review.files[0] ?? {}), false);
	});
});

test("real baseline checks retain success/failure, committed SHA, timestamps, bounded durable logs and no inherited provider tokens", async () => {
	const previous = process.env["GITHUB_TOKEN"];
	process.env["GITHUB_TOKEN"] = "test-only-provider-secret";
	try {
		await fixture(
			async ({ runtime, owned, prepare }) => {
				const job = await prepare();
				await writeFile(join(job.worktreePath as string, "source.txt"), "actual edit\n");
				const result = await runtime.finalize(job, signal());
				assert.deepEqual(
					result.checks.map((check) => check.exitCode),
					[0, 7]
				);
				for (const check of result.checks) {
					assert.equal(check.commitSha, result.headSha);
					assert.ok(Date.parse(check.finishedAt) >= Date.parse(check.startedAt));
					assert.ok(Buffer.byteLength(await runtime.getLog(check.logId)) < 65_000);
					assert.equal(
						(await runtime.getLog(check.logId)).includes("test-only-provider-secret"),
						false
					);
					assert.equal(
						(await lstat(join(owned, "logs", `${check.logId}.log`))).mode & 0o777,
						0o600
					);
				}
				assert.match(await runtime.getLog(result.checks[1]?.logId as string), /Output truncated/);
				const restarted = new WorkJobRuntime({ directory: owned, getToken: async () => undefined });
				assert.deepEqual(await restarted.getChecks(job.id), result.checks);
				assert.equal(
					(await restarted.review({ ...job, ...result })).files[0]?.head.commitSha,
					result.headSha
				);
			},
			{
				lint: "node validate.cjs",
				test: "node -e \"process.stdout.write('x'.repeat(90000));process.exit(7)\"",
			},
			"if (process.env.GITHUB_TOKEN) process.exit(9); console.log('real success');\n"
		);
	} finally {
		if (previous === undefined) Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
		else process.env["GITHUB_TOKEN"] = previous;
	}
});

test("no changes preserve the actual base/head without fabricating a commit or a passing check", async () => {
	await fixture(async ({ runtime, prepare, base }) => {
		const job = await prepare();
		const result = await runtime.finalize(job, signal());
		assert.equal(result.headSha, base);
		assert.deepEqual(result.changedFiles, []);
		assert.deepEqual(result.checks, []);
		assert.deepEqual((await runtime.review({ ...job, ...result })).files, []);
	});
});

test("feedback preparation pins actual PR head, nullable ticket summary and independent branch", async () => {
	await fixture(async ({ source, runtime, repository, job, base }) => {
		await writeFile(join(source, "source.txt"), "actual pull request head\n");
		await git(source, "add", ".");
		await git(source, "commit", "-m", "PR change");
		const prHead = await git(source, "rev-parse", "HEAD");
		assert.notEqual(prHead, base);
		const feedback = {
			id: "actual-comment",
			prId: "actual-pr",
			author: "reviewer",
			body: "Preserve source text",
			url: "https://github.com/actual-owner/actual-repository/pull/17#discussion_r4",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			kind: "inline" as const,
			state: null,
			path: "source.txt",
			line: 1,
			commitSha: prHead,
			suggestion: null,
		};
		const prepared = {
			...job,
			feedback,
			...(await runtime.prepare(repository, job, signal(), { baseCommit: prHead })),
		};
		assert.equal(prepared.baseSha, prHead);
		await writeFile(join(prepared.worktreePath, "source.txt"), "addressed real feedback\n");
		const result = await runtime.finalize(prepared, signal());
		assert.match(
			await git(prepared.worktreePath, "show", "-s", "--format=%B"),
			/Address review feedback: Preserve source text/
		);
		const review = await runtime.review({ ...prepared, ...result });
		assert.equal(review.files[0]?.base.commitSha, prHead);
		assert.equal(review.files[0]?.base.content, "actual pull request head\n");
	});
});

test("review preserves rename identities, deleted/added source, binary, large and exact UTF-8/BOM content", async () => {
	await fixture(async ({ source, runtime, repository, job }) => {
		await writeFile(join(source, "rename.txt"), "unchanged rename source\n".repeat(10));
		await writeFile(join(source, "delete.txt"), "deleted verbatim\n");
		await git(source, "add", ".");
		await git(source, "commit", "-m", "Review baseline");
		const prepared = { ...job, ...(await runtime.prepare(repository, job, signal())) };
		const tree = prepared.worktreePath;
		await rename(join(tree, "rename.txt"), join(tree, "renamed.txt"));
		await rm(join(tree, "delete.txt"));
		await writeFile(join(tree, "binary.bin"), Buffer.from([0, 255, 1]));
		await writeFile(join(tree, "invalid-utf8.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
		await writeFile(join(tree, "large.txt"), "a".repeat(300_001));
		await writeFile(
			join(tree, "unicode.txt"),
			"\ufeffvalid replacement character \ufffd\nlast line without newline"
		);
		const result = await runtime.finalize(prepared, signal());
		const review = await runtime.review({ ...prepared, ...result });
		const files = new Map(review.files.map((file) => [file.path, file]));
		assert.equal(files.get("renamed.txt")?.status, "renamed");
		assert.equal(files.get("renamed.txt")?.base.path, "rename.txt");
		assert.equal(files.get("renamed.txt")?.head.path, "renamed.txt");
		assert.equal(files.get("delete.txt")?.head.status, "missing");
		assert.equal(files.get("binary.bin")?.head.status, "binary");
		assert.equal(files.get("binary.bin")?.patch, null);
		assert.equal(files.get("invalid-utf8.bin")?.head.status, "binary");
		assert.equal(files.get("large.txt")?.head.status, "too-large");
		assert.equal(files.get("large.txt")?.patch, null);
		assert.equal(files.get("unicode.txt")?.base.status, "missing");
		assert.equal(
			files.get("unicode.txt")?.head.content,
			"\ufeffvalid replacement character \ufffd\nlast line without newline"
		);
	});
});

test("cancellation stops a real running validation command and persists its failed check on the committed head", async () => {
	await fixture(
		async ({ runtime, prepare }) => {
			const job = await prepare();
			await writeFile(join(job.worktreePath as string, "source.txt"), "edit before cancellation\n");
			const controller = new AbortController();
			const completing = runtime.finalize(job, controller.signal);
			// A marker in the owned tmp directory proves the actual command has started.
			const marker = join(job.worktreePath as string, "..", "tmp", "started");
			const deadline = Date.now() + 5000;
			while (!(await lstat(marker).catch(() => undefined))) {
				assert.ok(Date.now() < deadline, "local check started within bound");
				await new Promise((done) => setTimeout(done, 20));
			}
			await assert.rejects(runtime.finalize(job, signal()), /already active/);
			const childPid = Number(await readFile(marker, "utf8"));
			const before = Date.now();
			controller.abort();
			await assert.rejects(completing, /cancelled/);
			assert.ok(Date.now() - before < 3000);
			const stoppedBy = Date.now() + 2000;
			while (true) {
				try {
					process.kill(childPid, 0);
				} catch (error) {
					assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
					break;
				}
				assert.ok(Date.now() < stoppedBy, "actual validation process stopped");
				await new Promise((done) => setTimeout(done, 20));
			}
			const checks = await runtime.getChecks(job.id);
			assert.equal(checks.length, 1);
			assert.equal(checks[0]?.exitCode, 130);
			assert.equal(
				checks[0]?.commitSha,
				await git(job.worktreePath as string, "rev-parse", "HEAD")
			);
			assert.match(await runtime.getLog(checks[0]?.logId as string), /Check cancelled/);
		},
		{ test: "node validate.cjs" },
		"require('node:fs').writeFileSync(require('node:path').join(process.env.TMPDIR,'started'), String(process.pid)); setInterval(()=>{},1000);\n"
	);
});

test("rejects invalid registration, branch/path escapes, symlink replacement and stale identities without outside writes", async () => {
	await fixture(async ({ root, source, runtime, repository, job, owned, prepare }) => {
		await assert.rejects(
			runtime.prepare({ ...repository, repository: "someone/else" }, job, signal()),
			/origin/
		);
		await assert.rejects(
			runtime.prepare({ ...repository, localPath: join(source, "..") }, job, signal())
		);
		await assert.rejects(
			runtime.prepare(repository, { ...job, branch: "muse/../../outside" }, signal()),
			/branch/
		);
		assert.equal(await lstat(owned).catch(() => undefined), undefined);
		const prepared = await prepare();
		await assert.rejects(
			runtime.finalize({ ...prepared, worktreePath: source }, signal()),
			/ownership/
		);
		await assert.rejects(
			runtime.finalize({ ...prepared, baseSha: "f".repeat(40) }, signal()),
			/ownership/
		);
		await assert.rejects(runtime.getLog("../../outside"), /identity/);
		const original = prepared.worktreePath as string;
		await rename(original, `${original}-retained`);
		await symlink(source, original);
		await assert.rejects(runtime.finalize(prepared, signal()), /directory/);
		await rm(original);
		await rename(`${original}-retained`, original);
		const alias = join(root, "owned-alias");
		await symlink(owned, alias);
		const throughAlias = new WorkJobRuntime({ directory: alias, getToken: async () => undefined });
		await assert.rejects(
			throughAlias.prepare(repository, { id: "other", branch: "muse/other" }, signal()),
			/directory/
		);
		assert.equal(await lstat(join(owned, "jobs", "other")).catch(() => undefined), undefined);
		assert.equal(
			await readFile(join(source, "source.txt"), "utf8"),
			"first line\r\nsecond line\r\n"
		);
	});
});

test("checks that change committed source reject readiness and remain real evidence", async () => {
	await fixture(
		async ({ runtime, prepare }) => {
			const job = await prepare();
			await assert.rejects(runtime.finalize(job, signal()), /Validation changed/);
			const checks = await runtime.getChecks(job.id);
			assert.equal(checks.length, 1);
			assert.equal(checks[0]?.exitCode, 0);
			assert.equal(checks[0]?.commitSha, job.baseSha);
		},
		{ test: "node validate.cjs" },
		"require('node:fs').appendFileSync('source.txt','uncommitted test edit');\n"
	);
});

test("resume keeps the existing independent edits and rejects changed prepared identity", async () => {
	await fixture(async ({ runtime, prepare, repository, job, owned }) => {
		const prepared = await prepare();
		await writeFile(
			join(prepared.worktreePath as string, "source.txt"),
			"saved independent work\n"
		);
		const restarted = new WorkJobRuntime({
			directory: owned,
			getToken: async () => {
				throw new Error("No network");
			},
		});
		const deadPid = Number(
			(await exec(process.execPath, ["-e", "process.stdout.write(String(process.pid))"])).stdout
		);
		await writeFile(
			join(prepared.worktreePath as string, "..", "operation.lock"),
			JSON.stringify({ pid: deadPid }),
			{ mode: 0o600, flag: "wx" }
		);
		assert.deepEqual(await restarted.prepare(repository, job, signal()), {
			worktreePath: prepared.worktreePath,
			branch: prepared.branch,
			baseSha: prepared.baseSha,
		});
		assert.equal(
			await readFile(join(prepared.worktreePath as string, "source.txt"), "utf8"),
			"saved independent work\n"
		);
		await assert.rejects(
			runtime.prepare(repository, { ...job, branch: "muse/changed" }, signal()),
			/ownership/
		);
		await assert.rejects(
			runtime.prepare(repository, job, signal(), { baseCommit: "a".repeat(40) }),
			/ownership/
		);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(runtime.finalize(prepared, controller.signal), /cancelled/);
	});
});

test("does not run repository hooks and uses a deterministic identity without local author configuration", async () => {
	await fixture(async ({ root, source, prepare, runtime }) => {
		await git(source, "config", "--unset", "user.name");
		await git(source, "config", "--unset", "user.email");
		const outside = join(root, "hook-must-not-write");
		const hook = `#!/bin/sh\nprintf unsafe > '${outside}'\n`;
		await mkdir(join(source, ".git", "hooks"), { recursive: true });
		await writeFile(join(source, ".git", "hooks", "post-checkout"), hook, { mode: 0o700 });
		const job = await prepare();
		const tree = job.worktreePath as string;
		const bare = join(tree, "..", "repository.git");
		await mkdir(join(bare, "hooks"), { recursive: true });
		await writeFile(join(bare, "hooks", "post-commit"), hook, { mode: 0o700 });
		await writeFile(join(tree, "source.txt"), "actual edit\n");
		await assert.rejects(runtime.finalize(job, signal()), /explicit convention decision/);
		assert.equal(await lstat(outside).catch(() => undefined), undefined);
		await rm(join(bare, "hooks", "post-commit"));
		await runtime.finalize(job, signal());
		assert.equal(await git(tree, "show", "-s", "--format=%an <%ae>"), "Muse <muse@localhost>");
		assert.equal(await lstat(outside).catch(() => undefined), undefined);
	});
});

test("rejects rewritten Git configuration and symlinked owned metadata before mutations", async () => {
	await fixture(async ({ source, prepare, runtime }) => {
		const job = await prepare();
		const tree = job.worktreePath as string;
		const bare = join(tree, "..", "repository.git");
		await git(bare, "config", "url.file:///outside.insteadOf", "https://github.com/");
		await assert.rejects(runtime.finalize(job, signal()), /configuration/);
		await git(bare, "config", "--unset", "url.file:///outside.insteadOf");
		const ref = join(bare, "refs", "heads", job.branch);
		await rename(ref, `${ref}.retained`);
		await symlink(join(source, ".git", "refs", "heads", "trunk"), ref);
		await assert.rejects(runtime.finalize(job, signal()), /Unsafe work job file/);
		await rm(ref);
		await rename(`${ref}.retained`, ref);
		const objects = join(bare, "objects", "aa");
		const retained = await lstat(objects).catch(() => undefined);
		if (retained) await rename(objects, `${objects}-retained`);
		await symlink(join(source, ".git", "objects"), objects);
		await assert.rejects(runtime.finalize(job, signal()), /object directory/);
		assert.equal(
			await readFile(join(source, "source.txt"), "utf8"),
			"first line\r\nsecond line\r\n"
		);
	});
});

/** Test-only transport redirects the explicit HTTPS argv to an actual temporary bare Git remote.
 * No HTTP server, provider call or product transport injection is used. Git still performs its
 * real advertisement, pre-push hook, pack transfer and atomic ref update/rejection. */
async function localPushTransport(
	root: string,
	remote: string,
	work: (capture: string) => Promise<void>,
	race?: { ref: string; sha: string }
) {
	const executable = (await exec("/usr/bin/which", ["git"])).stdout.trim();
	const bin = join(root, "git-transport");
	await mkdir(bin);
	const capture = join(root, "git-network-argv.jsonl");
	const wrapper = `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); const fs=require('node:fs');\nlet args=process.argv.slice(2);\nif(args.includes('https://github.com/actual-owner/actual-repository.git')) {\n  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args)+'\\n');\n  if(args.includes('push') && ${JSON.stringify(Boolean(race))}) { const r=spawnSync(${JSON.stringify(executable)}, ['update-ref', ${JSON.stringify(race?.ref ?? "unused")}, ${JSON.stringify(race?.sha ?? "unused")}], {cwd:${JSON.stringify(remote)},env:process.env}); if(r.status!==0) process.exit(91); }\n  args=args.map(a=>a==='https://github.com/actual-owner/actual-repository.git'?${JSON.stringify(remote)}:a);\n  args.unshift('-c','protocol.file.allow=always');\n}\nconst result=spawnSync(${JSON.stringify(executable)},args,{stdio:'inherit',env:process.env}); process.exit(result.status??1);\n`;
	await writeFile(join(bin, "git"), wrapper, { mode: 0o700 });
	const previous = process.env["PATH"];
	process.env["PATH"] = `${bin}:${previous ?? "/usr/bin:/bin"}`;
	try {
		await work(capture);
	} finally {
		if (previous === undefined) Reflect.deleteProperty(process.env, "PATH");
		else process.env["PATH"] = previous;
	}
}

test("ordinary no-force push publishes the actual local commit and keeps credentials out of argv/config/logs", async () => {
	await fixture(async ({ root, source, owned, repository, prepare }) => {
		const job = await prepare();
		let tokenRequests = 0;
		const runtime = new WorkJobRuntime({
			directory: owned,
			getToken: async () => {
				tokenRequests++;
				return "test-only-private-token";
			},
		});
		await writeFile(join(job.worktreePath as string, "source.txt"), "actual publication\n");
		const finalized = { ...job, ...(await runtime.finalize(job, signal())) };
		const remote = join(root, "local-remote.git");
		await git(root, "clone", "--bare", "--no-hardlinks", "--", source, remote);
		await localPushTransport(root, remote, async (capture) => {
			await runtime.push(finalized, repository, signal());
			assert.equal(await git(remote, "rev-parse", `refs/heads/${job.branch}`), finalized.headSha);
			const calls = (await readFile(capture, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			assert.equal(calls.length, 2);
			assert.ok(calls[1]?.includes("--no-force"));
			assert.ok(
				calls.every(
					(args) =>
						!args.some(
							(arg) =>
								arg.includes("test-only-private-token") ||
								arg === "--force" ||
								arg.startsWith("--force-with-lease")
						)
				)
			);
			await runtime.push(finalized, repository, signal()); // Idempotent exact-head publication.
		});
		assert.equal(tokenRequests, 3);
		assert.deepEqual(await readdir(join(owned, "credentials")), []);
		assert.equal(
			(
				await readFile(join(job.worktreePath as string, "..", "repository.git", "config"), "utf8")
			).includes("test-only-private-token"),
			false
		);
	});
});

test("feedback push rejects a concurrent fast-forward remote advance between observation and push advertisement", async () => {
	await fixture(async ({ root, source, owned, repository, prepare }) => {
		const job = await prepare();
		const tree = job.worktreePath as string;
		const remote = join(root, "local-remote.git");
		await git(root, "clone", "--bare", "--no-hardlinks", "--", source, remote);
		const target = "actual-existing-pr-branch";
		await git(remote, "update-ref", `refs/heads/${target}`, job.baseSha as string);
		await writeFile(join(tree, "source.txt"), "intermediate actual change\n");
		await git(tree, "add", ".");
		await git(tree, "commit", "-m", "Intermediate");
		const intermediate = await git(tree, "rev-parse", "HEAD");
		// Copy the intermediate commit into the test remote without changing the PR ref yet.
		await git(
			remote,
			"-c",
			"protocol.file.allow=always",
			"fetch",
			"--",
			join(tree, "..", "repository.git"),
			`${intermediate}:refs/heads/race-object`
		);
		await writeFile(join(tree, "source.txt"), "final actual change\n");
		const runtime = new WorkJobRuntime({
			directory: owned,
			getToken: async () => "test-only-private-token",
		});
		const finalized = { ...job, ...(await runtime.finalize(job, signal())) };
		const feedbackJob: WorkJob = {
			...finalized,
			pullRequest: {
				id: "actual-pr",
				repository: repository.repository,
				number: 17,
				url: "https://github.com/actual-owner/actual-repository/pull/17",
				title: "Actual PR",
				author: "author",
				baseSha: job.baseSha as string,
				headSha: job.baseSha as string,
			},
			feedback: {
				id: "actual-feedback",
				prId: "actual-pr",
				author: "reviewer",
				body: "Actual feedback",
				url: "https://github.com/actual-owner/actual-repository/pull/17#issuecomment-4",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				kind: "conversation",
				state: null,
				path: null,
				line: null,
				commitSha: null,
				suggestion: null,
			},
		};
		await assert.rejects(
			runtime.push(feedbackJob, repository, signal()),
			/current pull request head/
		);
		await localPushTransport(
			root,
			remote,
			async () => {
				await assert.rejects(
					runtime.push(feedbackJob, repository, signal(), target),
					/Git operation failed/
				);
				assert.equal(await git(remote, "rev-parse", `refs/heads/${target}`), intermediate);
			},
			{ ref: `refs/heads/${target}`, sha: intermediate }
		);
	});
});
