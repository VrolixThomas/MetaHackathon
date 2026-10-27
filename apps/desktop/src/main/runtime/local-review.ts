import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	CommitShaSchema,
	GitHubRepositorySchema,
	RepositoryPathSchema,
	type ReviewFile,
} from "../../shared/contracts";
import { executionEnvironment } from "./environment";

/** Arguments only; no hooks, replace objects, credential helpers, lazy fetch or worktree writes. */
function git(
	cwd: string,
	args: string[],
	signal?: AbortSignal,
	maxBuffer = 64_000
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			[
				"--no-replace-objects",
				"--literal-pathspecs",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"protocol.allow=never",
				...args,
			],
			{
				cwd,
				signal,
				encoding: "buffer",
				maxBuffer,
				timeout: 10_000,
				env: executionEnvironment({
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_OPTIONAL_LOCKS: "0",
					GIT_NO_LAZY_FETCH: "1",
					GIT_TERMINAL_PROMPT: "0",
				}),
			},
			(error, stdout) => (error ? reject(error) : resolve(stdout))
		);
	});
}

function originRepository(origin: string): string {
	const ssh = /^git@github\.com:([^\s]+)$/.exec(origin);
	let repository = ssh?.[1];
	if (!repository) {
		let url: URL;
		try {
			url = new URL(origin);
		} catch {
			throw new Error("Selected repository needs a GitHub origin remote");
		}
		if (
			url.hostname !== "github.com" ||
			!["https:", "ssh:"].includes(url.protocol) ||
			url.password ||
			url.search ||
			url.hash ||
			url.port ||
			(url.username && !(url.protocol === "ssh:" && url.username === "git"))
		)
			throw new Error(
				"Selected repository needs a GitHub origin remote without embedded credentials"
			);
		repository = url.pathname.slice(1);
	}
	return GitHubRepositorySchema.max(240).parse(repository.replace(/\.git$/, ""));
}

export async function describeLocalRepository(
	path: string,
	signal?: AbortSignal
): Promise<{ repository: string; localPath: string }> {
	if (!isAbsolute(path) || path.includes("\0"))
		throw new Error("Select an absolute local repository folder");
	signal?.throwIfAborted();
	try {
		const selected = await realpath(path);
		if (!(await stat(selected)).isDirectory()) throw new Error("Not a folder");
		const localPath = await realpath(
			(await git(selected, ["rev-parse", "--show-toplevel"], signal)).toString("utf8").trim()
		);
		const repository = originRepository(
			(await git(localPath, ["remote", "get-url", "origin"], signal)).toString("utf8").trim()
		);
		signal?.throwIfAborted();
		return { repository, localPath };
	} catch (error) {
		if (signal?.aborted) throw new Error("Local repository inspection cancelled");
		// Git stderr/remotes can contain embedded credentials. Never return them.
		if (error instanceof Error && error.message.startsWith("Selected repository needs"))
			throw error;
		throw new Error("Could not inspect the selected Git repository and its GitHub origin");
	}
}

export async function validateLocalRepository(
	path: string,
	repository: string,
	signal?: AbortSignal
): Promise<string> {
	const expected = GitHubRepositorySchema.max(240).parse(repository);
	const actual = await describeLocalRepository(path, signal);
	if (actual.repository.toLowerCase() !== expected.toLowerCase())
		throw new Error("Local repository origin does not match the connected GitHub repository");
	return actual.localPath;
}

/** Undefined means only that this commit is absent, allowing an exact-SHA remote fallback. */
export async function readLocalReviewSource(
	localPath: string,
	repository: string,
	pathInput: string,
	shaInput: string,
	signal?: AbortSignal
): Promise<ReviewFile["base"] | undefined> {
	const path = RepositoryPathSchema.max(4096).parse(pathInput);
	const commitSha = CommitShaSchema.parse(shaInput);
	const canonical = await validateLocalRepository(localPath, repository, signal);
	if (canonical !== localPath)
		throw new Error("Local repository canonical path changed; reconnect it");
	try {
		try {
			const commit = (
				await git(canonical, ["rev-parse", "--verify", "--quiet", `${commitSha}^{commit}`], signal)
			)
				.toString("utf8")
				.trim();
			if (commit !== commitSha) throw new Error("Pinned commit identity mismatch");
		} catch (error) {
			if ((error as { code?: unknown }).code === 1 && !signal?.aborted) return undefined;
			throw error;
		}
		const entry = (await git(canonical, ["ls-tree", "-z", commitSha, "--", path], signal)).toString(
			"utf8"
		);
		if (!entry) return { path, commitSha, status: "missing", content: null };
		const match = /^[0-7]+ blob ([a-f0-9]{40})\t([\s\S]*)\0$/.exec(entry);
		if (!match || match[2] !== path) throw new Error("Requested source is not a blob");
		const size = Number(
			(await git(canonical, ["cat-file", "-s", match[1] as string], signal)).toString("utf8").trim()
		);
		if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid object size");
		if (size > 300_000) return { path, commitSha, status: "too-large", content: null };
		const bytes = await git(
			canonical,
			["show", "--no-ext-diff", "--no-textconv", `${commitSha}:${path}`],
			signal,
			300_001
		);
		if (bytes.length !== size) throw new Error("Incomplete pinned object");
		if (bytes.includes(0)) return { path, commitSha, status: "binary", content: null };
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			return { path, commitSha, status: "binary", content: null };
		}
		signal?.throwIfAborted();
		return { path, commitSha, status: "available", content };
	} catch {
		throw new Error(
			signal?.aborted ? "Local review read cancelled" : "Could not read the pinned local Git source"
		);
	}
}
