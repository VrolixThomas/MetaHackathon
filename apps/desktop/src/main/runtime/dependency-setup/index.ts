import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executionEnvironment } from "../environment";
import { runProcess } from "../process";

export class DependencySetupError extends Error {}
export const dependencyFile = (path: string) =>
	/(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.yarnrc(?:\.yml)?|bunfig\.toml)$/.test(
		path
	);

/** Main supplies immutable Git blob identities, never model-selected commands or packages. */
export async function setupDependencies(options: {
	tree: string;
	directory: string;
	baseline: Record<string, string>;
	signal: AbortSignal;
	verify: () => Promise<void>;
}): Promise<string> {
	const { tree, directory, baseline, signal, verify } = options;
	const receipt = join(directory, "dependency-setup.json");
	let command: string | null = null;
	let args: string[] = [];
	let output = "";
	let exitCode: number | null = null;
	const startedAt = new Date().toISOString();
	async function persist(value: unknown): Promise<void> {
		const temporary = join(directory, `dependency-setup-${randomUUID()}.json`);
		await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
		await rename(temporary, receipt);
	}

	const check = () => {
		if (signal.aborted) throw new Error("Dependency setup cancelled");
	};
	async function inspectModules(path: string): Promise<void> {
		check();
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const target = join(path, entry.name);
			if (entry.isSymbolicLink()) {
				const actual = await realpath(target);
				if (!actual.startsWith(`${tree}/`))
					throw new Error("Dependency link escapes owned checkout");
			} else if (entry.isDirectory()) await inspectModules(target);
		}
	}
	async function inspect(): Promise<void> {
		check();
		await verify();
		const found: string[] = [];
		async function walk(path: string) {
			for (const entry of await readdir(join(tree, path), { withFileTypes: true })) {
				if (entry.name === ".git") continue;
				if (entry.name === "node_modules") {
					if (!entry.isDirectory() || entry.isSymbolicLink())
						throw new Error("Unsafe dependency directory");
					await inspectModules(join(tree, path, entry.name));
					continue;
				}
				const name = path ? `${path}/${entry.name}` : entry.name;
				if (dependencyFile(name)) found.push(name);
				if (entry.isDirectory()) await walk(name);
				else if (entry.isSymbolicLink())
					throw new Error("Dependency setup refuses symlinked repository inputs");
			}
		}
		await walk("");
		if (JSON.stringify(found.sort()) !== JSON.stringify(Object.keys(baseline).sort()))
			throw new Error("Dependency metadata differs from the admitted baseline");
		for (const path of found) {
			const target = join(tree, path);
			const info = await lstat(target);
			if (
				!info.isFile() ||
				info.isSymbolicLink() ||
				info.nlink !== 1 ||
				info.size > 20_000_000 ||
				(await realpath(target)) !== target
			)
				throw new Error("Unsafe dependency input");
			const bytes = await readFile(target);
			const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
			if (oid !== baseline[path]) throw new Error(`Dependency baseline drift: ${path}`);
		}
	}
	try {
		await inspect();
		if (!baseline["package.json"]) return "No package manifest; dependency setup not required.";
		const pkg = JSON.parse(await readFile(join(tree, "package.json"), "utf8"));
		const declared = pkg.packageManager;
		const match =
			typeof declared === "string"
				? /^(bun|npm)@(\d+\.\d+\.\d+)(?:\+sha\d+\.[a-f0-9]+)?$/.exec(declared)
				: null;
		if (declared !== undefined && !match)
			throw new Error("Unsupported packageManager; setup supports pinned Bun and npm only");
		if (!declared && (baseline["pnpm-lock.yaml"] || baseline["yarn.lock"]))
			throw new Error(
				"Unsupported package manager lockfile; declare a supported pinned Bun or npm manager"
			);
		command =
			match?.[1] ??
			(baseline["bun.lock"] || baseline["bun.lockb"]
				? "bun"
				: baseline["package-lock.json"] || baseline["npm-shrinkwrap.json"]
					? "npm"
					: null);
		if (
			!command ||
			(command === "bun"
				? !baseline["bun.lock"] && !baseline["bun.lockb"]
				: !baseline["package-lock.json"] && !baseline["npm-shrinkwrap.json"])
		)
			throw new Error("Dependency setup requires a baseline Bun or npm frozen lockfile");
		args = command === "bun" ? ["install", "--frozen-lockfile"] : ["ci", "--no-audit", "--no-fund"];
		const home = join(directory, "dependency-home");
		const tmp = join(directory, "dependency-tmp");
		for (const path of [home, tmp]) {
			await mkdir(path, { recursive: true, mode: 0o700 });
			if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path)
				throw new Error("Unsafe dependency setup directory");
		}
		const globalConfig = join(home, "npm-globalconfig");
		await writeFile(globalConfig, "", { mode: 0o600, flag: "wx" }).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
			}
		);
		const configInfo = await lstat(globalConfig);
		if (
			!configInfo.isFile() ||
			configInfo.isSymbolicLink() ||
			configInfo.nlink !== 1 ||
			configInfo.size !== 0
		)
			throw new Error("Unsafe package manager global configuration");
		const env = executionEnvironment({
			HOME: home,
			TMPDIR: tmp,
			CI: "1",
			npm_config_userconfig: "/dev/null",
			npm_config_globalconfig: globalConfig,
			npm_config_cache: join(home, "npm-cache"),
			BUN_INSTALL_CACHE_DIR: join(home, "bun-cache"),
			XDG_CACHE_HOME: join(home, "cache"),
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		});
		const version = await runProcess({
			command,
			args: ["--version"],
			cwd: tree,
			env,
			signal,
			timeoutMs: 10000,
			maxOutputBytes: 1000,
		});
		if (version.aborted || signal.aborted) {
			exitCode = 130;
			throw new Error("Dependency setup cancelled during package manager version check");
		}
		if (
			version.exitCode !== 0 ||
			version.aborted ||
			version.timedOut ||
			(match && version.stdout.trim() !== match[2])
		)
			throw new Error("Required baseline package manager version is unavailable");
		// Repeat the frozen install on resume: existence of node_modules is not proof of completion.
		// Normal baseline lifecycle behavior is required for Electron/native dependency setup.
		check();
		const result = await runProcess({
			command,
			args,
			cwd: tree,
			env,
			signal,
			timeoutMs: 600000,
			maxOutputBytes: 64000,
		});
		output = `${result.stdout}${result.stderr}${result.outputTruncated ? "\n[truncated]" : ""}`;
		exitCode = result.aborted ? 130 : result.timedOut ? 124 : (result.exitCode ?? 127);
		if (exitCode !== 0) throw new Error(`Frozen dependency setup exited ${exitCode}`);
		await inspect();
		await persist({
			id: randomUUID(),
			startedAt,
			finishedAt: new Date().toISOString(),
			command,
			args,
			exitCode,
			output,
			baseline,
			lifecycle: "baseline-default",
		});
		return `Dependencies prepared with ${command} ${args.join(" ")}; receipt: ${receipt}`;
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Dependency setup failed";
		await persist({
			startedAt,
			finishedAt: new Date().toISOString(),
			command,
			args,
			exitCode,
			output,
			reason,
			baseline,
		});
		throw new DependencySetupError(
			`Dependency setup failed: ${reason}. Inspect ${receipt}, correct the setup issue, then resume.`
		);
	}
}
