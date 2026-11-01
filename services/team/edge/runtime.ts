import { Buffer } from "node:buffer";
import type { EdgeEnvironment } from "./config";
import type { EdgeHandler } from "./http";
import type { WorkerPorts } from "./worker";

interface EdgeHost {
	Deno?: {
		env: { toObject(): Record<string, string> };
		serve(handler: EdgeHandler): unknown;
	};
	EdgeRuntime?: { waitUntil(pending: Promise<unknown>): void };
	Buffer?: typeof Buffer;
}

/** The only deployment startup boundary. No Bun/process loop or desktop lifecycle imports. */
export function startEdge(
	factory: (env: EdgeEnvironment, ports: WorkerPorts) => EdgeHandler,
	background = false
): void {
	const host = globalThis as unknown as EdgeHost;
	if (!host.Deno) throw new Error("Build this entrypoint for the Supabase Edge runtime");
	if (background && !host.EdgeRuntime) throw new Error("The worker requires EdgeRuntime.waitUntil");
	// Existing services use the Node-compatible global; bind it explicitly in the Deno bundle.
	host.Buffer ??= Buffer;
	const shutdown = new AbortController();
	globalThis.addEventListener("beforeunload", () => shutdown.abort(), { once: true });
	const handler = factory(host.Deno.env.toObject(), {
		signal: shutdown.signal,
		...(background
			? {
					waitUntil: (pending: Promise<unknown>) => host.EdgeRuntime?.waitUntil(pending),
					recordOutcome: (httpStatus: number) =>
						console.info(JSON.stringify({ type: "team-worker-tick", httpStatus })),
					recordUsage: (record) => console.info(JSON.stringify({ type: "model-usage", ...record })),
				}
			: {}),
	});
	host.Deno.serve(handler);
}
