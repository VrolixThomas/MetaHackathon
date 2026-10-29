import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

/** A repository and its worktrees share configuration; explicit launch overrides remain authoritative. */
export async function developmentEnvPath(checkout: string): Promise<string> {
	try {
		const { stdout } = await promisify(execFile)(
			"git",
			[
				"--no-optional-locks",
				"-C",
				checkout,
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			],
			{ timeout: 2000, maxBuffer: 8192 }
		);
		const common = stdout.trim();
		if (basename(common) === ".git") {
			const shared = join(dirname(common), ".env");
			if (existsSync(shared)) return shared;
		}
	} catch {
		/* Non-Git development bundles still use their explicit checkout config. */
	}
	return join(checkout, ".env");
}
