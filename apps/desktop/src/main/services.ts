import { TRPCError } from "@trpc/server";
import { type RuntimeOptions, RuntimeService } from "./runtime/service";

let runtime: RuntimeService | undefined;

export function initializeRuntime(options: RuntimeOptions): void {
	if (runtime) throw new Error("Runtime has already been initialized");
	runtime = new RuntimeService(options);
}

export function getRuntime(): RuntimeService {
	if (!runtime) {
		throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Review runtime is unavailable" });
	}
	return runtime;
}

export async function disposeRuntime(): Promise<void> {
	const current = runtime;
	// Reject new RPC work as soon as shutdown begins, before awaiting owned process cleanup.
	runtime = undefined;
	await current?.dispose();
}
