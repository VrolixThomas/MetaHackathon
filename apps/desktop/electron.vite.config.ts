import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Electron must launch as an app even when the parent shell uses Electron as Node.
// biome-ignore lint/performance/noDelete: Electron checks whether this variable exists.
delete process.env["ELECTRON_RUN_AS_NODE"];

export default defineConfig({
	main: {
		// Release builds embed OAuth app registrations from CI secrets (see builtin.ts).
		define: Object.fromEntries(
			[
				"MUSE_GITHUB_OAUTH_CLIENT_ID",
				"MUSE_GITHUB_OAUTH_CLIENT_SECRET",
				"MUSE_LINEAR_OAUTH_CLIENT_ID",
				"MUSE_LINEAR_OAUTH_CLIENT_SECRET",
				"MUSE_SLACK_OAUTH_CLIENT_ID",
			].map((key) => [`process.env.${key}`, JSON.stringify(process.env[key] ?? "")])
		),
		plugins: [
			externalizeDepsPlugin(),
			{
				name: "copy-drizzle-migrations",
				closeBundle() {
					const source = resolve(__dirname, "src/main/db/migrations");
					if (existsSync(source)) {
						cpSync(source, resolve(__dirname, "out/main/db/migrations"), {
							recursive: true,
						});
					}
				},
			},
		],
		build: {
			rollupOptions: {
				input: {
					index: resolve(__dirname, "src/main/index.ts"),
					"coding-worker": resolve(__dirname, "src/main/work/coding-entry.ts"),
				},
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: resolve(__dirname, "src/preload/index.ts"),
				output: { format: "cjs", entryFileNames: "index.cjs" },
			},
		},
	},
	renderer: {
		plugins: [react()],
		resolve: { alias: { "@": resolve(__dirname, "src/renderer") } },
		build: {
			rollupOptions: {
				input: resolve(__dirname, "src/renderer/index.html"),
			},
		},
	},
});
