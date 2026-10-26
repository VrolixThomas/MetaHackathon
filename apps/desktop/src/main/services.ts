import { TRPCError } from "@trpc/server";
import { ScreenContextStore } from "./agent/screen-context";
import { createAgentComposition } from "./composition";
import type { RuntimeOptions, RuntimeService } from "./runtime/service";

let runtime: RuntimeService | undefined;
let dataDirectory: string | undefined;
let closing = false;
export const screenContexts = new ScreenContextStore();
export const agentComposition = createAgentComposition({
	getRuntime: runtimeForActiveJobs,
	getDataDirectory: () => {
		if (!dataDirectory) throw new Error("Application storage is unavailable");
		return dataDirectory;
	},
	screenContexts,
	buildCommand: (pr) =>
		pr.repository === "demo/shop-web" && new URL(pr.url).hostname === "example.invalid"
			? { command: process.execPath, args: ["--experimental-strip-types", "scenarios/build.mjs"] }
			: undefined,
});

export function initializeRuntime(options: RuntimeOptions): void {
	if (runtime) throw new Error("Runtime has already been initialized");
	dataDirectory = options.userDataPath;
	runtime = agentComposition.createRuntime(options);
}

export function getRuntime(): RuntimeService {
	if (closing) {
		throw new TRPCError({
			code: "SERVICE_UNAVAILABLE",
			message: "Review runtime is shutting down",
		});
	}
	return runtimeForActiveJobs();
}

function runtimeForActiveJobs(): RuntimeService {
	if (!runtime) {
		throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Review runtime is unavailable" });
	}
	return runtime;
}

export async function disposeRuntime(): Promise<void> {
	const current = runtime;
	closing = true;
	try {
		// Drain provider, confirmation and source jobs while their runtime/ledger remains available.
		await agentComposition.dispose();
	} finally {
		runtime = undefined;
		screenContexts.clear();
		await current?.dispose();
		dataDirectory = undefined;
	}
}
