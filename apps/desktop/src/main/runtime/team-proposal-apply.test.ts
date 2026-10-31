import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import type { WatchedRepository } from "../../shared/contracts";
import { executionEnvironment } from "./environment";
import {
	TeamProposalApplyDecisionRequired,
	type TeamProposalApplyInput,
	type TeamProposalAuthorization,
	applyAcceptedTeamProposal,
	acceptedTeamProposalDigest as digest,
} from "./team-proposal-apply";
import { WorkJobRuntime } from "./work-job-runtime";
const exec = promisify(execFile);
const signal = () => new AbortController().signal;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const blob = (text: string) => ({ text, sha256: sha(text) });
async function git(cwd: string, ...args: string[]) {
	return (
		await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
			cwd,
			encoding: "utf8",
			env: executionEnvironment({
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_AUTHOR_NAME: "Local acceptance",
				GIT_AUTHOR_EMAIL: "test@example.invalid",
				GIT_COMMITTER_NAME: "Local acceptance",
				GIT_COMMITTER_EMAIL: "test@example.invalid",
				GIT_OPTIONAL_LOCKS: "0",
			}),
		})
	).stdout.trim();
}
async function fixture(t: TestContext, check = "console.log('actual inert declared check');\n") {
	const root = await realpath(await mkdtemp(join(tmpdir(), "team-proposal-apply-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "source");
	const owned = join(root, "owned");
	await mkdir(source);
	await git(source, "init", "--initial-branch=main", "--template=");
	await git(source, "remote", "add", "origin", "https://github.com/local-owner/local-proposal.git");
	await git(source, "config", "user.name", "Local acceptance");
	await git(source, "config", "user.email", "test@example.invalid");
	const pkg = JSON.stringify({ packageManager: "bun@1.3.9", scripts: { test: "node check.cjs" } });
	await writeFile(join(source, "package.json"), pkg);
	await writeFile(join(source, "check.cjs"), check);
	await writeFile(join(source, "file.txt"), "\uFEFFold\r\nexact bytes\r\n");
	await writeFile(join(source, "remove.txt"), "remove this\n");
	await git(source, "add", ".");
	await git(source, "commit", "-m", "Local base");
	const base = await git(source, "rev-parse", "HEAD");
	await writeFile(join(source, "file.txt"), "dirty user work\n");
	const repository: WatchedRepository = {
		id: "registered-local",
		repository: "local-owner/local-proposal",
		localPath: source,
		defaultBranch: "main",
		addedAt: new Date().toISOString(),
		linearTeamIds: [],
		linearProjectIds: [],
	};
	const runtime = new WorkJobRuntime({
		directory: owned,
		getToken: async () => {
			throw new Error("Provider calls forbidden in local test");
		},
	});
	const files: TeamProposalApplyInput["bundle"]["files"] = [
		{
			path: "file.txt",
			before: blob("\uFEFFold\r\nexact bytes\r\n"),
			after: blob("\uFEFFnew\r\nexact bytes\r\n"),
		},
	];
	const candidate = "c".repeat(40);
	const checks = [
		{
			command: ["MUST_NEVER_EXECUTE_PROPOSAL_COMMAND"],
			commitSha: candidate,
			startedAt: "2026-11-01T00:00:00Z",
			finishedAt: "2026-11-01T00:00:01Z",
			exitCode: 0,
			environment: "untrusted reported candidate",
			output: blob("reported, not actual local verification"),
		},
	];
	const bundle: TeamProposalApplyInput["bundle"] = {
		key: {
			orgId: randomUUID(),
			repositoryId: "123",
			prNumber: 7,
			baseSha: "a".repeat(40),
			headSha: base,
			contextDigest: "b".repeat(64),
			analysisVersion: "1",
		},
		feedback: {
			kind: "issue-comment",
			id: "456",
			revision: "2026-11-01T00:00:00Z",
			body: "Source feedback",
			bodyDigest: sha("Source feedback"),
		},
		baseSha: base,
		candidateSha: candidate,
		files,
		patch: blob("Reported patch text is never executed"),
		checks,
		checksDigest: digest(checks),
		sourcesDigest: digest(files),
		provenance: "reported-local-candidate",
	};
	const input: TeamProposalApplyInput = {
		requestId: randomUUID(),
		proposalId: randomUUID(),
		bundleDigest: digest(bundle),
		bundle,
	};
	const authorization: TeamProposalAuthorization = {
		proposalId: input.proposalId,
		bundleDigest: input.bundleDigest,
		decisionId: randomUUID(),
		decision: "accept",
		repository: repository.repository,
		headSha: base,
		authorUserId: "actual-author",
		acceptedByUserId: "actual-author",
	};
	let calls = 0;
	const ports = {
		runtime,
		repository,
		authorizeCurrent: async () => {
			calls++;
			return authorization;
		},
	};
	const jobRoot = () =>
		join(
			owned,
			"jobs",
			createHash("sha256").update(`team-proposal-${input.requestId}`).digest("hex")
		);
	const refresh = () => {
		input.bundle.sourcesDigest = digest(input.bundle.files);
		input.bundle.checksDigest = digest(input.bundle.checks);
		input.bundleDigest = digest(input.bundle);
		authorization.bundleDigest = input.bundleDigest;
	};
	const snapshot = async () => ({
		head: await git(source, "rev-parse", "HEAD"),
		refs: await git(source, "show-ref"),
		status: await git(source, "status", "--porcelain"),
		index: await readFile(join(source, ".git/index")),
		config: await readFile(join(source, ".git/config")),
		dirty: await readFile(join(source, "file.txt")),
	});
	return {
		root,
		source,
		owned,
		runtime,
		input,
		authorization,
		ports,
		calls: () => calls,
		base,
		pkg,
		refresh,
		snapshot,
		jobRoot,
	};
}

test("applies exact accepted UTF-8 add/modify/delete privately and returns actual local commit/check review, preserving dirty user source", async (t) => {
	const f = await fixture(t);
	f.input.bundle.files.push(
		{ path: "remove.txt", before: blob("remove this\n"), after: null },
		{ path: "nested/new.txt", before: null, after: blob("new exact file\n") }
	);
	f.refresh();
	const before = await f.snapshot();
	const result = await applyAcceptedTeamProposal(f.input, f.ports, signal());
	assert.notEqual(result.appliedSha, f.base);
	assert.equal(result.proposedCandidateSha, f.input.bundle.candidateSha);
	assert.notEqual(result.appliedSha, result.proposedCandidateSha);
	assert.equal(result.review.job.headSha, result.appliedSha);
	assert.equal(result.decisionId, f.authorization.decisionId);
	assert.deepEqual(result.review.files.map((file) => file.path).sort(), [
		"file.txt",
		"nested/new.txt",
		"remove.txt",
	]);
	assert.equal(
		await readFile(join(result.worktreePath, "file.txt"), "utf8"),
		f.input.bundle.files[0]?.after?.text
	);
	assert.equal(await lstat(join(result.worktreePath, "remove.txt")).catch(() => null), null);
	assert.equal(result.checks.length, 1);
	assert.equal(result.checks[0]?.exitCode, 0);
	assert.equal(result.checks[0]?.commitSha, result.appliedSha);
	assert.deepEqual(result.checks[0]?.args, ["run", "test"]);
	assert.match(
		await readFile(join(f.owned, "logs", `${result.checks[0]?.logId}.log`), "utf8"),
		/actual inert declared check/
	);
	assert.ok(f.calls() > 12);
	assert.deepEqual(await f.snapshot(), before);
	await assert.rejects(applyAcceptedTeamProposal(f.input, f.ports, signal()), /existing or extra/);
});

test("requires actual current author acceptance/digest/head before creating any owned job", async (t) => {
	for (const field of ["headSha", "acceptedByUserId", "bundleDigest", "proposalId"] as const) {
		const f = await fixture(t);
		const auth = {
			...f.authorization,
			[field]:
				field === "headSha"
					? "d".repeat(40)
					: field === "bundleDigest"
						? "e".repeat(64)
						: field === "proposalId"
							? randomUUID()
							: "another-user",
		};
		await assert.rejects(
			applyAcceptedTeamProposal(
				f.input,
				{ ...f.ports, authorizeCurrent: async () => auth },
				signal()
			),
			/current author/
		);
		assert.equal(await lstat(f.owned).catch(() => null), null);
	}
});

test("rejects tampered digest, extra bundle fields, traversal, duplicate/case/parent paths and Git escapes", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		applyAcceptedTeamProposal({ ...f.input, bundleDigest: "0".repeat(64) }, f.ports, signal()),
		/identity mismatch/
	);
	await assert.rejects(
		applyAcceptedTeamProposal(
			{ ...f.input, bundle: { ...f.input.bundle, commands: ["bad"] } },
			f.ports,
			signal()
		)
	);
	for (const path of [
		"../escape",
		"/escape",
		".git/config",
		"nested/.GIT/HEAD",
		"a\\b",
		"a/../b",
		"a.",
		"bad\u200cname",
	]) {
		f.input.bundle.files = [{ path, before: null, after: blob("bad") }];
		f.refresh();
		await assert.rejects(applyAcceptedTeamProposal(f.input, f.ports, signal()));
	}
	for (const paths of [
		["same", "same"],
		["Same", "same"],
		["a", "a/b"],
	]) {
		f.input.bundle.files = paths.map((path) => ({ path, before: null, after: blob("x") }));
		f.refresh();
		await assert.rejects(applyAcceptedTeamProposal(f.input, f.ports, signal()));
	}
	assert.equal(f.calls(), 0);
});

test("before-byte mismatch rejects before touching any accepted file", async (t) => {
	const f = await fixture(t);
	const before = await f.snapshot();
	const file = f.input.bundle.files[0];
	assert.ok(file);
	file.before = blob("different exact bytes");
	f.refresh();
	await assert.rejects(
		applyAcceptedTeamProposal(f.input, f.ports, signal()),
		/source bytes mismatch/
	);
	assert.deepEqual(await f.snapshot(), before);
});

test("package metadata/dependency edits keep baseline scripts; changed scripts require a separate explicit convention decision", async (t) => {
	const f = await fixture(t);
	f.input.bundle.files = [
		{
			path: "package.json",
			before: blob(f.pkg),
			after: blob(
				JSON.stringify({
					...JSON.parse(f.pkg),
					dependencies: { "unused-local-only": "1.0.0" },
					description: "accepted metadata",
				})
			),
		},
	];
	f.refresh();
	const result = await applyAcceptedTeamProposal(f.input, f.ports, signal());
	assert.equal(result.checks[0]?.exitCode, 0);
	const unsafe = await fixture(t);
	unsafe.input.bundle.files = [
		{
			path: "package.json",
			before: blob(unsafe.pkg),
			after: blob(JSON.stringify({ ...JSON.parse(unsafe.pkg), scripts: { test: "node bad.cjs" } })),
		},
	];
	unsafe.refresh();
	await assert.rejects(
		applyAcceptedTeamProposal(unsafe.input, unsafe.ports, signal()),
		TeamProposalApplyDecisionRequired
	);
	assert.equal(unsafe.calls(), 0);
});

test("a revoked acceptance after partial local bytes blocks further mutation and never returns applied", async (t) => {
	const f = await fixture(t);
	let revoked = false;
	const original = f.ports.authorizeCurrent;
	f.ports.authorizeCurrent = async () => {
		const value = await original();
		const contents = await readFile(join(f.jobRoot(), "worktree/file.txt"), "utf8").catch(
			() => null
		);
		if (contents === f.input.bundle.files[0]?.after?.text) {
			revoked = true;
			throw new Error("Actual author acceptance revoked");
		}
		return value;
	};
	await assert.rejects(applyAcceptedTeamProposal(f.input, f.ports, signal()), /revoked/);
	assert.equal(revoked, true);
	assert.equal(await git(f.source, "rev-parse", "HEAD"), f.base);
});

test("post-finalize authorization/head changes withhold success even though owned commit/checks completed", async (t) => {
	const f = await fixture(t);
	const original = f.runtime.finalize.bind(f.runtime);
	let finalized = false;
	f.runtime.finalize = async (...args) => {
		const result = await original(...args);
		finalized = true;
		return result;
	};
	const authorizeCurrent = async () => ({
		...f.authorization,
		headSha: finalized ? "f".repeat(40) : f.base,
	});
	await assert.rejects(
		applyAcceptedTeamProposal(f.input, { ...f.ports, authorizeCurrent }, signal()),
		/current author/
	);
	assert.equal(finalized, true);
});

test("unsafe symlink sources and extra effects in an existing isolated job are rejected", async (t) => {
	const f = await fixture(t);
	const original = f.runtime.prepare.bind(f.runtime);
	f.runtime.prepare = async (...args) => {
		const result = await original(...args);
		await symlink(f.source, join(result.worktreePath, "escape"));
		return result;
	};
	f.input.bundle.files = [{ path: "escape/new.txt", before: null, after: blob("never outside") }];
	f.refresh();
	await assert.rejects(applyAcceptedTeamProposal(f.input, f.ports, signal()), /extra|unsafe/);
	assert.equal(await lstat(join(f.source, "new.txt")).catch(() => null), null);
});

test("actual failing declared checks retain local candidate and never report success", async (t) => {
	const f = await fixture(t, "process.exit(7);\n");
	await assert.rejects(
		applyAcceptedTeamProposal(f.input, f.ports, signal()),
		/checks did not pass/
	);
});

test("tracked symlink parents are refused even when the checkout is otherwise clean", async (t) => {
	const f = await fixture(t);
	await symlink(f.source, join(f.source, "linked"));
	await git(f.source, "add", "--", "linked");
	await git(f.source, "commit", "-m", "Tracked unsafe parent");
	const head = await git(f.source, "rev-parse", "HEAD");
	f.input.bundle.baseSha = head;
	f.input.bundle.key.headSha = head;
	f.authorization.headSha = head;
	f.input.bundle.files = [
		{
			path: "linked/file.txt",
			before: blob("dirty user work\n"),
			after: blob("never write outside\n"),
		},
	];
	f.refresh();
	await assert.rejects(
		applyAcceptedTeamProposal(f.input, f.ports, signal()),
		/unsafe source parent/
	);
	assert.equal(await readFile(join(f.source, "file.txt"), "utf8"), "dirty user work\n");
});

test("accepted add/delete may be reported as a rename by the actual runtime review", async (t) => {
	const f = await fixture(t);
	f.input.bundle.files = [
		{ path: "remove.txt", before: blob("remove this\n"), after: null },
		{ path: "renamed.txt", before: null, after: blob("remove this\n") },
	];
	f.refresh();
	const result = await applyAcceptedTeamProposal(f.input, f.ports, signal());
	assert.equal(result.review.files.length, 1);
	assert.equal(result.review.files[0]?.status, "renamed");
	assert.equal(result.review.files[0]?.head.content, "remove this\n");
});

test("repository commit-hook convention is retained and never bypassed by shared acceptance", async (t) => {
	const f = await fixture(t);
	const hook = join(f.source, ".git/hooks/pre-commit");
	await mkdir(join(f.source, ".git/hooks"));
	await writeFile(hook, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
	await assert.rejects(
		applyAcceptedTeamProposal(f.input, f.ports, signal()),
		/explicit convention decision/
	);
});

test("cancellation interrupts an unresponsive authorization read before any job mutation", async (t) => {
	const f = await fixture(t);
	const controller = new AbortController();
	const pending = applyAcceptedTeamProposal(
		f.input,
		{ ...f.ports, authorizeCurrent: () => new Promise(() => {}) },
		controller.signal
	);
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(await lstat(f.owned).catch(() => null), null);
});
