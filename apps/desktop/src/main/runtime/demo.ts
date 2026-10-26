import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executionEnvironment } from "./environment";
import { runProcess } from "./process";

export interface SeededRepository {
	path: string;
	baseSha: string;
	headSha: string;
}

/** Each seed creates an independent local Git repository; demo PR numbers are references only. */
export async function seedDemoRepositories(root: string, fixturesPath: string) {
	const runId = randomUUID();
	const directory = join(root, `demo-${runId}`);
	await mkdir(root, { recursive: true });
	await mkdir(directory);
	const ownerFile = join(directory, ".runtime-owner.json");
	await writeFile(ownerFile, JSON.stringify({ runId }), { mode: 0o600 });
	const git = async (cwd: string, args: string[]) => {
		const result = await runProcess({
			command: "git",
			args: ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
			cwd,
			env: executionEnvironment({
				GIT_AUTHOR_NAME: "Noor (demo fixture)",
				GIT_AUTHOR_EMAIL: "noor@example.invalid",
				GIT_COMMITTER_NAME: "MetaHackathon fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.invalid",
				GIT_AUTHOR_DATE: "2026-10-26T10:00:00Z",
				GIT_COMMITTER_DATE: "2026-10-26T10:00:00Z",
			}),
			timeoutMs: 15_000,
		});
		if (result.exitCode !== 0) throw new Error(`Demo Git operation failed: ${result.stderr}`);
		return result.stdout.trim();
	};
	const seed = async (name: string): Promise<SeededRepository> => {
		const path = join(directory, name);
		await cp(join(fixturesPath, name, "base"), path, { recursive: true });
		await git(path, ["init", "--initial-branch=main"]);
		await git(path, ["add", "."]);
		await git(path, ["commit", "-m", `${name}: before promo stacking`]);
		const baseSha = await git(path, ["rev-parse", "HEAD"]);
		await git(path, ["checkout", "-b", "demo/promo-stacking"]);
		await cp(join(fixturesPath, name, "head"), path, { recursive: true, force: true });
		await git(path, ["add", "."]);
		await git(path, [
			"commit",
			"-m",
			name === "shop-web"
				? "SHOP-482: stack promo and loyalty with 40% cap"
				: "Read promo_code added by shop-web #1284",
		]);
		const headSha = await git(path, ["rev-parse", "HEAD"]);
		return { path, baseSha, headSha };
	};
	const cleanup = async () => {
		const owner = JSON.parse(await readFile(ownerFile, "utf8"));
		if (owner.runId !== runId) throw new Error("Demo ownership changed; refusing cleanup");
		// Call only after RepositoryManager has removed its separately owned worktrees.
		for (const name of ["shop-web", "finance-service"]) {
			try {
				const trees = await git(join(directory, name), ["worktree", "list", "--porcelain"]);
				if (trees.split("\n").filter((line) => line.startsWith("worktree ")).length > 1)
					throw new Error("Demo still has worktrees; clean them before deleting the seed");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		await rm(directory, { recursive: true });
	};
	try {
		return {
			runId,
			directory,
			shop: await seed("shop-web"),
			finance: await seed("finance-service"),
			cleanup,
		};
	} catch (error) {
		// This brand-new, UUID-owned directory contains no user checkout.
		await rm(directory, { recursive: true });
		throw error;
	}
}
