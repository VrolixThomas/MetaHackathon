import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	type CodingProviderSettings,
	CodingProviderSettingsSchema,
} from "../../../shared/contracts";
import { abortable, throwIfAborted } from "../../agent/cancellation";
import {
	type CodingTaskInput,
	CodingTaskInputSchema,
	CodingWorkerCheckpointSchema,
} from "../../agent/coding-worker";

const MAX_PIN = 32768;
const MAX_CHECKPOINT = 2_000_000;
const absolute = z
	.string()
	.min(1)
	.max(4096)
	.refine((path) => isAbsolute(path) && !/[\0\r\n]/.test(path));
const settingsSchema = CodingProviderSettingsSchema.extend({ musePath: absolute.nullable() });
const directorySchema = z.strictObject({
	path: absolute,
	device: z.number().int().nonnegative(),
	inode: z.number().int().nonnegative(),
});
const pinSchema = z.strictObject({
	version: z.literal(1),
	kind: z.literal("coding-provider"),
	jobId: z.string().min(1).max(200),
	repository: z.string().min(1).max(300),
	worktree: directorySchema,
	parent: directorySchema,
	checkpointPath: absolute,
	taskKey: z.string().regex(/^[a-f0-9]{64}$/),
	settings: settingsSchema,
});
export type CodingProviderPin = z.infer<typeof pinSchema>;
type Identity = Omit<CodingProviderPin, "settings">;
type Location = { identity: Identity; marker: string; session: string; sessionLock: string };

export class CodingProviderPinError extends Error {
	constructor(readonly code: "identity" | "unsafe" | "ambiguous" | "settings") {
		super(
			{
				identity: "Coding provider checkpoint identity changed; the job cannot resume safely.",
				unsafe: "Coding provider checkpoint storage is unsafe or unavailable.",
				ambiguous: "Coding provider checkpoint state is ambiguous; no provider was started.",
				settings: "Coding provider settings are invalid; no provider was started.",
			}[code]
		);
		this.name = "CodingProviderPinError";
	}
}
function fail(code: CodingProviderPinError["code"]): never {
	throw new CodingProviderPinError(code);
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const within = (root: string, path: string) => {
	const value = relative(root, path);
	return !value || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
};

/** Parents are main-owned, outside model worktrees. Reject symlink components before any mkdir. */
async function directory(path: string, create: boolean) {
	const absolutePath = resolve(path);
	let cursor = parse(absolutePath).root;
	for (const part of absolutePath.slice(cursor.length).split(sep).filter(Boolean)) {
		cursor = join(cursor, part);
		let info = await lstat(cursor).catch((error) => {
			if (!missing(error)) throw error;
			return null;
		});
		if (!info && create) {
			await mkdir(cursor, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
			});
			info = await lstat(cursor);
		}
		if (!info?.isDirectory() || info.isSymbolicLink()) fail("unsafe");
	}
	const info = await lstat(absolutePath);
	const canonical = await realpath(absolutePath);
	if (
		canonical !== absolutePath ||
		!Number.isSafeInteger(info.dev) ||
		!Number.isSafeInteger(info.ino)
	)
		fail("unsafe");
	return { path: canonical, device: info.dev, inode: info.ino };
}
async function locate(input: CodingTaskInput, create: boolean): Promise<Location> {
	const worktree = await directory(input.worktreePath, false);
	const checkpoint = resolve(absolute.parse(input.checkpointPath));
	if (within(worktree.path, checkpoint)) fail("unsafe");
	const parent = await directory(dirname(checkpoint), create);
	if (within(worktree.path, parent.path)) fail("unsafe");
	const identity: Identity = {
		version: 1,
		kind: "coding-provider",
		jobId: input.jobId,
		repository: input.repository,
		worktree,
		parent,
		checkpointPath: join(parent.path, basename(checkpoint)),
		// Same exact task key as the Meta worker. Hash only: no brief/prompt/history in the sidecar.
		taskKey: digest({
			jobId: input.jobId,
			ticketId: input.ticket?.id ?? null,
			repository: input.repository,
			worktreePath: resolve(input.worktreePath),
			brief: input.brief,
		}),
	};
	return {
		identity,
		// Per job rather than per filename: PR fixes share a parent, but a renamed checkpoint cannot repin a job.
		marker: join(parent.path, `.coding-provider-${digest(input.jobId)}.json`),
		session: `${identity.checkpointPath}.muse-code.json`,
		sessionLock: `${identity.checkpointPath}.muse-code.json.lock`,
	};
}
class PublishingLink extends Error {}
async function readPrivate(
	path: string,
	maximum: number,
	publication = false,
	json = true
): Promise<unknown | null> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const before = await handle.stat();
		if (publication && before.isFile() && before.nlink === 2) throw new PublishingLink();
		if (
			!before.isFile() ||
			before.nlink !== 1 ||
			(before.mode & 0o777) !== 0o600 ||
			before.size <= 0 ||
			before.size > maximum ||
			(typeof process.getuid === "function" && before.uid !== process.getuid())
		)
			fail("unsafe");
		const bytes = Buffer.alloc(maximum + 1);
		let size = 0;
		while (size < bytes.length) {
			const result = await handle.read(bytes, size, bytes.length - size, size);
			if (!result.bytesRead) break;
			size += result.bytesRead;
		}
		const after = await handle.stat();
		if (
			size > maximum ||
			size !== before.size ||
			after.size !== before.size ||
			after.nlink !== 1 ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			(after.mode & 0o777) !== 0o600
		)
			fail("unsafe");
		return json ? JSON.parse(bytes.subarray(0, size).toString("utf8")) : true;
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	} finally {
		await handle?.close();
	}
}
async function readPin(path: string, signal: AbortSignal) {
	for (let retry = 0; ; retry++) {
		throwIfAborted(signal);
		try {
			return await readPrivate(path, MAX_PIN, true);
		} catch (error) {
			// A create-only publisher unlinks its temporary hardlink before returning.
			// Persistent hardlinks remain forbidden; no provider starts while the file is linked.
			if (!(error instanceof PublishingLink) || retry >= 25) throw error;
			await new Promise<void>((done) => setTimeout(done, 10));
		}
	}
}
async function checkpointKind(location: Location, signal: AbortSignal) {
	throwIfAborted(signal);
	const checkpoint = await readPrivate(location.identity.checkpointPath, MAX_CHECKPOINT);
	throwIfAborted(signal);
	const session = await readPrivate(location.session, MAX_CHECKPOINT);
	throwIfAborted(signal);
	const sessionLock = await readPrivate(location.sessionLock, MAX_PIN, false, false);
	throwIfAborted(signal);
	if ((session !== null || sessionLock !== null) && checkpoint !== null) fail("ambiguous");
	if (session !== null || sessionLock !== null) return "muse-code";
	if (checkpoint === null) return "empty";
	const meta = CodingWorkerCheckpointSchema.safeParse(checkpoint);
	if (!meta.success) fail("ambiguous");
	if (
		meta.data.jobId !== location.identity.jobId ||
		meta.data.taskKey !== location.identity.taskKey
	)
		fail("identity");
	return "meta-api";
}
async function verify(location: Location, raw: unknown, signal: AbortSignal) {
	const pin = pinSchema.parse(raw);
	const { settings: _settings, ...identity } = pin;
	if (!same(identity, location.identity)) fail("identity");
	const kind = await checkpointKind(location, signal);
	if (kind !== "empty" && kind !== pin.settings.provider) fail("ambiguous");
	return pin;
}
async function publish(location: Location, pin: CodingProviderPin, signal: AbortSignal) {
	throwIfAborted(signal);
	const bytes = JSON.stringify(pinSchema.parse(pin));
	if (Buffer.byteLength(bytes) > MAX_PIN) fail("unsafe");
	const temp = join(location.identity.parent.path, `.coding-provider-publish-${randomUUID()}`);
	let handle: FileHandle | undefined;
	try {
		handle = await open(
			temp,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600
		);
		await handle.writeFile(bytes, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		throwIfAborted(signal);
		if (!same(await directory(location.identity.parent.path, false), location.identity.parent))
			fail("identity");
		try {
			await link(temp, location.marker);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return; // An atomic concurrent winner is authoritative; never overwrite it.
		}
		await unlink(temp);
		const parent = await open(
			location.identity.parent.path,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
		);
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	} finally {
		await handle?.close();
		await unlink(temp).catch((error) => {
			if (!missing(error)) throw error;
		});
	}
}

async function finish(
	location: Location,
	raw: unknown,
	input: CodingTaskInput,
	signal: AbortSignal
) {
	const pin = await verify(location, raw, signal);
	if (!same(await locate(input, false), location)) fail("identity");
	const parent = await open(
		location.identity.parent.path,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
	);
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
	throwIfAborted(signal);
	if (!same(await locate(input, false), location)) fail("identity");
	return pin;
}

/** Immutable provider preferences per exact main-owned job. Main still owns the single active worker. */
export async function pinCodingProvider(
	raw: CodingTaskInput,
	readSettings: () => Promise<CodingProviderSettings>,
	signal: AbortSignal
): Promise<CodingProviderPin> {
	try {
		throwIfAborted(signal);
		const input = CodingTaskInputSchema.parse(raw);
		let location = await locate(input, true);
		throwIfAborted(signal);
		const prior = await readPin(location.marker, signal);
		if (prior !== null) return await finish(location, prior, input, signal);
		const kind = await checkpointKind(location, signal);
		if (kind === "muse-code") fail("ambiguous"); // No unpinned CLI session adoption.
		let settings: z.infer<typeof settingsSchema>;
		if (kind === "meta-api") settings = { provider: "meta-api", musePath: null };
		else {
			try {
				settings = settingsSchema.parse(await abortable(readSettings(), signal));
			} catch {
				fail("settings");
			}
		}
		throwIfAborted(signal);
		const checked = await locate(input, false);
		if (!same(checked, location)) fail("identity");
		location = checked;
		await publish(location, { ...location.identity, settings }, signal);
		throwIfAborted(signal);
		return await finish(location, await readPin(location.marker, signal), input, signal);
	} catch (error) {
		if (signal.aborted) throw new DOMException("Coding provider selection cancelled", "AbortError");
		if (error instanceof CodingProviderPinError) throw error;
		throw new CodingProviderPinError("unsafe");
	}
}
