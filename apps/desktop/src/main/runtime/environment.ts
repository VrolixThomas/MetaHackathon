/** Reviewed code must not inherit API credentials or Electron's embedded Node mode. */
export function executionEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		PATH: process.env["PATH"] ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
		HOME: process.env["HOME"],
		TMPDIR: process.env["TMPDIR"],
		LANG: "en_US.UTF-8",
		...extra,
	};
}
