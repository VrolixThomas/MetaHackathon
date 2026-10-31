import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { z } from "zod";
import type { CodingTaskInput } from "../../agent/coding-worker";
import { CodingTaskResultSchema } from "../../agent/coding-worker";
import { MuseCodeRuntimeError } from "./protocol";

export const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const CheckpointSchema = z.strictObject({
	version: z.literal(1),
	taskKey: z.string(),
	musePath: z.string(),
	cliVersion: z.string(),
	sessionId: z.string().min(1),
	profileId: z.string().min(1),
	phase: z.enum([
		"opening",
		"idle",
		"submitting",
		"running",
		"question",
		"approval",
		"answering",
		"settled",
	]),
	commandId: z.string().nullable(),
	turnId: z.string().nullable(),
	contextDigest: z.string(),
	decisionDigest: z.string(),
	pendingQuestion: z
		.strictObject({
			userInputId: z.string(),
			questionId: z.string(),
			question: z.string().max(6000),
		})
		.nullable(),
	result: CodingTaskResultSchema.nullable(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
const within = (root: string, path: string) => {
	const rel = relative(root, path);
	return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

async function json(path: string): Promise<unknown> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 100_000 || (stat.mode & 0o077) !== 0)
			throw new MuseCodeRuntimeError("unavailable");
		return JSON.parse(await file.readFile("utf8"));
	} finally {
		await file.close();
	}
}
/** Verify the existing WorkJobRuntime-owned private worktree, never a user's ordinary checkout. */
export async function inspectTask(input: CodingTaskInput): Promise<{ key: string; path: string }> {
	if (
		(await realpath(input.worktreePath)) !== input.worktreePath ||
		basename(input.worktreePath) !== "worktree"
	)
		throw new MuseCodeRuntimeError("unavailable");
	const tree = await lstat(input.worktreePath);
	const ownership = z
		.object({
			id: z.string(),
			repository: z.string(),
			gitDirectory: z.string(),
			treeIdentity: z.object({ device: z.number(), inode: z.number() }),
		})
		.parse(await json(join(dirname(input.worktreePath), "ownership.json")));
	if (
		ownership.id !== input.jobId ||
		ownership.repository !== input.repository ||
		ownership.treeIdentity.device !== tree.dev ||
		ownership.treeIdentity.inode !== tree.ino ||
		ownership.gitDirectory !==
			join(dirname(input.worktreePath), "repository.git", "worktrees", "worktree")
	)
		throw new MuseCodeRuntimeError("unavailable");
	const pointer = await open(
		join(input.worktreePath, ".git"),
		constants.O_RDONLY | constants.O_NOFOLLOW
	);
	try {
		const stat = await pointer.stat();
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.size > 8192 ||
			(await pointer.readFile("utf8")).trim() !== `gitdir: ${ownership.gitDirectory}`
		)
			throw new MuseCodeRuntimeError("unavailable");
	} finally {
		await pointer.close();
	}
	let current = parse(input.checkpointPath).root;
	for (const part of dirname(input.checkpointPath)
		.slice(current.length)
		.split("/")
		.filter(Boolean)) {
		current = join(current, part);
		await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		const stat = await lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MuseCodeRuntimeError("unavailable");
	}
	const parent = dirname(input.checkpointPath);
	if (
		(await realpath(parent)) !== parent ||
		within(input.worktreePath, parent) ||
		((await lstat(parent)).mode & 0o077) !== 0
	)
		throw new MuseCodeRuntimeError("unavailable");
	return {
		key: digest({
			jobId: input.jobId,
			ticketId: input.ticket?.id ?? null,
			repository: input.repository,
			worktree: input.worktreePath,
			device: tree.dev,
			inode: tree.ino,
			brief: input.brief,
			checkpoint: input.checkpointPath,
		}),
		path: `${input.checkpointPath}.muse-code.json`,
	};
}
export async function load(path: string): Promise<Checkpoint | null> {
	try {
		return CheckpointSchema.parse(await json(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
export async function save(path: string, state: Checkpoint): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify(CheckpointSchema.parse(state)));
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
		const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
/** Cross-process single writer; dead-owner recovery never discards session/turn uncertainty. */
export async function lock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const filePath = `${path}.lock`;
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const owner = z.object({ pid: z.int().positive() }).parse(await json(filePath));
		try {
			process.kill(owner.pid, 0);
			throw new MuseCodeRuntimeError("unavailable");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		await unlink(filePath);
		handle = await open(filePath, "wx", 0o600);
	}
	const identity = await handle.stat();
	try {
		await handle.writeFile(JSON.stringify({ pid: process.pid }));
		await handle.sync();
		return await operation();
	} finally {
		await handle.close();
		const current = await lstat(filePath);
		if (current.ino === identity.ino && current.dev === identity.dev && !current.isSymbolicLink())
			await unlink(filePath);
	}
}
