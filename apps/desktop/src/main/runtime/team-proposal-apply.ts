import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { ProposalBundleSchema, validateBundle } from "../../../../../services/team/proposals";
import {
	Digest,
	digest as acceptedTeamProposalDigest,
	canonical,
} from "../../../../../services/team/protocol";
import {
	CommitShaSchema,
	type WatchedRepository,
	WatchedRepositorySchema,
	WorkJobSchema,
} from "../../shared/contracts";
import { abortable } from "../agent/cancellation";
import { executionEnvironment } from "./environment";
import type { WorkJobRuntime } from "./work-job-runtime";

export const TeamProposalApplyInputSchema = z.strictObject({
	requestId: z.uuid(),
	proposalId: z.uuid(),
	bundleDigest: Digest,
	bundle: ProposalBundleSchema,
});
export type TeamProposalApplyInput = z.infer<typeof TeamProposalApplyInputSchema>;
export const TeamProposalAuthorizationSchema = z.strictObject({
	proposalId: z.uuid(),
	bundleDigest: Digest,
	decisionId: z.uuid(),
	decision: z.literal("accept"),
	repository: z.string().min(1).max(300),
	headSha: CommitShaSchema,
	authorUserId: z.string().min(1).max(200),
	acceptedByUserId: z.string().min(1).max(200),
});
export type TeamProposalAuthorization = z.infer<typeof TeamProposalAuthorizationSchema>;
export interface TeamProposalApplyPorts {
	runtime: WorkJobRuntime;
	repository: WatchedRepository;
	/** Root revalidates actual current author, acceptance/digest and PR head on EVERY call. No cached/self-granted consent. */
	authorizeCurrent(): Promise<TeamProposalAuthorization>;
}
const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export { acceptedTeamProposalDigest };
const fail = (message: string): never => {
	throw new Error(`Team proposal apply: ${message}`);
};
function safePath(path: string) {
	if (path.length > 4096) fail("unsafe repository path");
	for (const part of path.split("/")) {
		if (
			!part ||
			part === "." ||
			part === ".." ||
			/[\\:\p{C}]/u.test(part) ||
			/[. ]$/.test(part) ||
			/^\.git$/i.test(part.normalize("NFKC")) ||
			/^git~[0-9]+$/i.test(part)
		)
			fail("unsafe repository path");
	}
}
export class TeamProposalApplyDecisionRequired extends Error {
	readonly code = "execution-convention";
	constructor() {
		super(
			"Team proposal changes declared scripts or execution conventions; review that decision separately before applying."
		);
	}
}
function validate(raw: unknown) {
	const input = TeamProposalApplyInputSchema.parse(raw);
	const bundle = validateBundle(input.bundle);
	const files = bundle.files.map((file) => file.path.normalize("NFC").toLowerCase());
	if (
		acceptedTeamProposalDigest(bundle) !== input.bundleDigest ||
		new Set(files).size !== files.length
	)
		fail("bundle identity mismatch");
	for (const [index, file] of bundle.files.entries()) {
		safePath(file.path);
		if (files.some((other, position) => position !== index && other.startsWith(`${files[index]}/`)))
			fail("overlapping file paths");
		if (
			(!file.before && !file.after) ||
			(file.before && file.after && file.before.text === file.after.text)
		)
			fail("source identity mismatch");
		if (file.path.toLowerCase() === "package.json") {
			try {
				const pkg = z.object({
					scripts: z.record(z.string(), z.string()).default({}),
					packageManager: z.string().nullable().default(null),
					type: z.string().nullable().default(null),
				});
				const before = pkg.parse(file.before ? JSON.parse(file.before.text) : {});
				const after = pkg.parse(file.after ? JSON.parse(file.after.text) : {});
				if (canonical(before) !== canonical(after)) throw new TeamProposalApplyDecisionRequired();
			} catch {
				throw new TeamProposalApplyDecisionRequired();
			}
		}
	}
	return input;
}
const exec = promisify(execFile);
async function git(cwd: string, signal: AbortSignal, ...args: string[]) {
	const result = await exec(
		"git",
		[
			"--no-replace-objects",
			"--literal-pathspecs",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.attributesFile=/dev/null",
			...args,
		],
		{
			cwd,
			signal,
			timeout: 15_000,
			maxBuffer: 2_000_000,
			encoding: "utf8",
			env: executionEnvironment({
				GIT_OPTIONAL_LOCKS: "0",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
			}),
		}
	);
	return result.stdout;
}
async function optionalStat(path: string) {
	return lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return null;
	});
}
async function regularBytes(path: string) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 300_000) fail("unsafe source file");
		return await file.readFile();
	} finally {
		await file.close();
	}
}

/** Local application only. Unknown/revoked/failed attempts remain in the owned worktree, never replayed or published. */
export async function applyAcceptedTeamProposal(
	raw: unknown,
	ports: TeamProposalApplyPorts,
	signal: AbortSignal
) {
	const input = validate(raw);
	const repository = WatchedRepositorySchema.parse(ports.repository);
	const localPath = repository.localPath;
	if (!localPath) throw new Error("Team proposal apply: an existing local repository is required");
	const bundle = input.bundle;
	let authorization: TeamProposalAuthorization | undefined;
	const fresh = async () => {
		signal.throwIfAborted();
		const next = TeamProposalAuthorizationSchema.parse(
			await abortable(ports.authorizeCurrent(), signal)
		);
		signal.throwIfAborted();
		if (
			next.proposalId !== input.proposalId ||
			next.bundleDigest !== input.bundleDigest ||
			next.repository !== repository.repository ||
			next.headSha !== bundle.baseSha ||
			next.acceptedByUserId !== next.authorUserId ||
			(authorization && canonical(next) !== canonical(authorization))
		)
			fail("current author acceptance or PR head changed");
		authorization = next;
		return next;
	};
	await fresh();
	// Builtin object read prevents prepare's remote fetch fallback for a missing local base.
	await git(localPath, signal, "cat-file", "-e", `${bundle.baseSha}^{commit}`);
	const jobId = `team-proposal-${input.requestId}`;
	const now = new Date().toISOString();
	let job = WorkJobSchema.parse({
		id: jobId,
		ticket: null,
		repositoryId: repository.id,
		repository: repository.repository,
		state: "running",
		branch: `muse/team-proposal-${sha256(input.requestId).slice(0, 32)}`,
		worktreePath: null,
		baseSha: null,
		headSha: null,
		brief: `Apply accepted shared proposal ${input.proposalId} at exact digest ${input.bundleDigest}.`,
		summary: "Exact local source application; reported candidate checks are untrusted.",
		createdAt: now,
		updatedAt: now,
		decisions: [],
		checks: [],
		changedFiles: [],
		pullRequest: null,
		error: null,
	});
	await fresh();
	const prepared = await ports.runtime.prepare(repository, job, signal, {
		baseCommit: bundle.baseSha,
	});
	job = { ...job, ...prepared };
	await fresh();
	const tree = prepared.worktreePath;
	if (
		prepared.baseSha !== bundle.baseSha ||
		(await realpath(tree)) !== tree ||
		tree === repository.localPath ||
		tree.startsWith(`${repository.localPath}/`)
	)
		fail("worktree isolation mismatch");
	const treeStat = await lstat(tree);
	const pointer = await regularBytes(join(tree, ".git"));
	const root = async () => {
		const actual = await lstat(tree);
		if (
			actual.isSymbolicLink() ||
			actual.dev !== treeStat.dev ||
			actual.ino !== treeStat.ino ||
			(await realpath(tree)) !== tree ||
			!(await regularBytes(join(tree, ".git"))).equals(pointer)
		)
			fail("worktree ownership changed");
	};
	const parents = async (path: string, create: boolean) => {
		await root();
		let directory = tree;
		for (const part of path.split("/").slice(0, -1)) {
			directory = join(directory, part);
			let stat = await optionalStat(directory);
			if (!stat && create) {
				await fresh();
				await root();
				if ((await realpath(dirname(directory))) !== dirname(directory))
					fail("unsafe source parent");
				await mkdir(directory, { mode: 0o755 });
				stat = await lstat(directory);
			}
			if (!stat) return false;
			if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
				fail("unsafe source parent");
		}
		return true;
	};
	const verify = async (side: "before" | "after") => {
		for (const file of bundle.files) {
			const exists = await parents(file.path, false);
			const path = join(tree, file.path);
			const stat = exists ? await optionalStat(path) : null;
			const blob = file[side];
			if (!blob) {
				if (stat) fail("expected absent source");
				continue;
			}
			if (
				!stat?.isFile() ||
				stat.isSymbolicLink() ||
				!(await regularBytes(path)).equals(Buffer.from(blob.text, "utf8"))
			)
				fail("before/after source bytes mismatch");
		}
	};
	await root();
	if (
		(await git(tree, signal, "rev-parse", "HEAD")).trim() !== bundle.baseSha ||
		(await git(tree, signal, "status", "--porcelain=v1", "--untracked-files=all")).trim() ||
		(await git(tree, signal, "ls-files", "--others", "-z")).length
	)
		fail("existing or extra worktree effects require inspection");
	await verify("before");
	await fresh();
	await root();
	const leasePath = join(dirname(tree), "team-proposal-apply.lock");
	// Cross-call/process exclusion. Failed/uncertain attempts retain this marker for explicit inspection.
	const lease = await open(
		leasePath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600
	);
	await lease.close();
	await ports.runtime.bootstrap(job, signal);
	await fresh();
	await root();
	await verify("before");
	for (const file of bundle.files) {
		await fresh();
		await parents(file.path, true);
		const path = join(tree, file.path);
		const stat = await optionalStat(path);
		if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
			fail("unsafe mutation target");
		if (
			file.before
				? !stat || !(await regularBytes(path)).equals(Buffer.from(file.before.text, "utf8"))
				: stat
		)
			fail("source changed before mutation");
		await fresh();
		await parents(file.path, false);
		if (!file.after) {
			const current = await lstat(path);
			if (
				!current.isFile() ||
				current.isSymbolicLink() ||
				current.nlink !== 1 ||
				!(await regularBytes(path)).equals(Buffer.from(file.before?.text ?? "", "utf8"))
			)
				fail("source changed before deletion");
			await unlink(path);
			continue;
		}
		const handle = await open(
			path,
			constants.O_WRONLY |
				constants.O_NOFOLLOW |
				(file.before ? 0 : constants.O_CREAT | constants.O_EXCL),
			0o644
		);
		try {
			await fresh();
			await root();
			const actual = await handle.stat();
			if (
				!actual.isFile() ||
				actual.nlink !== 1 ||
				(stat && (actual.dev !== stat.dev || actual.ino !== stat.ino))
			)
				fail("mutation file identity changed");
			if (file.before && !(await regularBytes(path)).equals(Buffer.from(file.before.text, "utf8")))
				fail("source changed before write");
			if (file.before) await handle.truncate(0);
			await fresh();
			await root();
			if ((await handle.stat()).nlink !== 1) fail("mutation hardlink changed");
			await handle.writeFile(Buffer.from(file.after.text, "utf8"));
		} finally {
			await handle.close();
		}
	}
	await verify("after");
	const expected = bundle.files.map((file) => file.path).sort();
	const changed = async (base: string) =>
		[
			...new Set([
				...(
					await git(
						tree,
						signal,
						"diff",
						"--no-ext-diff",
						"--no-textconv",
						"--no-renames",
						"--name-only",
						"-z",
						base,
						"--"
					)
				)
					.split("\0")
					.filter(Boolean),
				...(await git(tree, signal, "ls-files", "--others", "--exclude-standard", "-z"))
					.split("\0")
					.filter(Boolean),
			]),
		].sort();
	if (canonical(await changed("HEAD")) !== canonical(expected))
		fail("extra or missing changed files");
	await fresh();
	await root();
	const finalized = await ports.runtime.finalize(job, signal);
	await fresh();
	await root();
	if (
		finalized.headSha === bundle.baseSha ||
		finalized.checks.some((check) => check.exitCode !== 0 || check.commitSha !== finalized.headSha)
	)
		fail("local finalization/checks did not pass");
	await verify("after");
	if (canonical(await changed(bundle.baseSha)) !== canonical(expected))
		fail("finalized files differ from accepted files");
	job = { ...job, ...finalized, state: "ready", updatedAt: new Date().toISOString() };
	await fresh();
	const review = await ports.runtime.review(job, signal);
	await fresh();
	for (const file of review.files) {
		const after = bundle.files.find((entry) => entry.path === file.path)?.after;
		if (
			after
				? file.head.status !== "available" || file.head.content !== after.text
				: file.head.status !== "missing"
		)
			fail("final committed source differs from accepted bytes");
	}
	await fresh();
	await root();
	await unlink(leasePath);
	const finalAuthorization = await fresh();
	return {
		proposalId: input.proposalId,
		bundleDigest: input.bundleDigest,
		requestId: input.requestId,
		decisionId: finalAuthorization.decisionId,
		baseSha: bundle.baseSha,
		proposedCandidateSha: bundle.candidateSha,
		appliedSha: finalized.headSha,
		jobId,
		worktreePath: tree,
		checks: finalized.checks,
		review,
	};
}
