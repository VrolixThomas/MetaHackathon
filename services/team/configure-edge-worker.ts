import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { SupabaseRest } from "./supabase";

/** Explicit operator command; deployment never starts the queue scheduler implicitly. */
export async function configureEdgeWorker(args: string[]) {
	if (args.length !== 1 || !["--enable", "--disable"].includes(args[0] ?? ""))
		throw new Error("Use --enable or --disable explicitly");
	const enabled = args[0] === "--enable";
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const linked = (await readFile(resolve(root, "supabase/.temp/project-ref"), "utf8")).trim();
	if (!/^[a-z0-9]{20}$/.test(linked)) throw new Error("Link a Supabase project first");
	const server = parseEnv(await readFile(resolve(root, "services/team/.env"), "utf8"));
	const url = `https://${linked}.supabase.co`;
	if (server["SUPABASE_URL"] !== url || !server["SUPABASE_SERVICE_ROLE_KEY"])
		throw new Error("Backend credentials must match the explicitly linked project");
	let invocationSecret: string | undefined;
	if (enabled) {
		const edge = parseEnv(await readFile(resolve(root, "services/team/.env.edge"), "utf8"));
		invocationSecret = edge["TEAM_WORKER_INVOKE_SECRET"];
		if (!invocationSecret || !/^[A-Za-z0-9_-]{32,128}$/.test(invocationSecret))
			throw new Error("Dedicated worker invocation key is missing");
		for (const name of ["muse-team-api", "muse-team-webhook", "muse-team-worker"]) {
			const response = await fetch(`${url}/functions/v1/${name}/health`, {
				signal: AbortSignal.timeout(15000),
			});
			const body = (await response.json()) as { status?: unknown };
			if (!response.ok || body.status !== "configured")
				throw new Error("Cloud provider configuration is incomplete; scheduler remains off");
		}
		// An invalid queue proves the dedicated key matches without claiming any job.
		const probe = await fetch(`${url}/functions/v1/muse-team-worker`, {
			method: "POST",
			headers: { Authorization: `Bearer ${invocationSecret}`, "Content-Type": "application/json" },
			body: JSON.stringify({ queue: "configuration-probe" }),
			signal: AbortSignal.timeout(15000),
		});
		const result = (await probe.json()) as { error?: unknown };
		if (probe.status !== 400 || result.error !== "invalid-queue")
			throw new Error("Worker invocation key verification failed; scheduler remains off");
	}
	const admin = new SupabaseRest({ url, key: server["SUPABASE_SERVICE_ROLE_KEY"] });
	return admin.rpc("team_configure_worker_scheduler", {
		p_project_url: enabled ? url : null,
		p_invoker_secret: invocationSecret ?? null,
		p_enabled: enabled,
	});
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void configureEdgeWorker(process.argv.slice(2)).then(
		(status) => console.log(JSON.stringify({ scheduler: status })),
		() => {
			console.error(
				"Worker configuration did not complete. Check the linked project, private backend files and function health; no secrets are printed."
			);
			process.exitCode = 1;
		}
	);
}
