import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MetaClient } from "../../apps/desktop/src/main/agent/meta-client";
import { TeamAccess } from "./access";
import { createTeamApi } from "./api";
import { TeamConsumer } from "./consumer";
import { HostedGitHub } from "./github";
import { SupabaseRest } from "./supabase";
import { receiveWebhook } from "./webhook";

const help = `Muse organization review service (MET-72/73/41)
Usage: bun services/team/entry.ts serve|consume [--once]
Required: SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SERVICE_ROLE_KEY
          GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY TEAM_ANALYSIS_VERSION
Serve:    GITHUB_WEBHOOK_SECRET TEAM_HOST(default 127.0.0.1) TEAM_PORT(default 8787)
Consume:  META_API_KEY (server preparation only; no coding subscription sessions)
No credentials, database, provider calls or sockets are used by --help.
Serve behind HTTPS. Only /health is public; /webhooks/github requires HMAC and /v1 requires user authorization.
`;
function required(env: NodeJS.ProcessEnv, key: string) {
	const value = env[key]?.trim();
	if (!value) throw new Error(`Missing required environment: ${key}`);
	return value;
}
export function dependencies(env: NodeJS.ProcessEnv) {
	const url = required(env, "SUPABASE_URL");
	const allowLocal = env.TEAM_ALLOW_LOCAL_SUPABASE === "1";
	const key = required(env, "SUPABASE_PUBLISHABLE_KEY");
	const admin = new SupabaseRest({
		url,
		key: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
		allowLocal,
	});
	const github = new HostedGitHub({
		appId: required(env, "GITHUB_APP_ID"),
		privateKey: required(env, "GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
	});
	const analysisVersion = required(env, "TEAM_ANALYSIS_VERSION");
	const access = new TeamAccess({
		admin,
		user: (token) => new SupabaseRest({ url, key, token, allowLocal }),
	});
	return { admin, github, analysisVersion, access };
}
export function serverHandler(env: NodeJS.ProcessEnv) {
	const deps = dependencies(env);
	const secret = required(env, "GITHUB_WEBHOOK_SECRET");
	const api = createTeamApi(deps.access, {
		admin: deps.admin,
		github: deps.github,
		analysisVersion: deps.analysisVersion,
	});
	return async (request: Request): Promise<Response> => {
		const path = new URL(request.url).pathname;
		if (path === "/health" && request.method === "GET") return Response.json({ status: "ok" });
		if (path === "/webhooks/github") return receiveWebhook(request, { secret, db: deps.admin });
		if (path.startsWith("/v1/")) return api(request);
		return Response.json({ error: "not-found" }, { status: 404 });
	};
}
export async function main(args: string[], env = process.env): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(help);
		return;
	}
	const mode = args[0];
	if (mode !== "serve" && mode !== "consume")
		throw new Error("Expected serve or consume; use --help");
	if (mode === "serve") {
		const handler = serverHandler(env);
		const port = Number(env.TEAM_PORT ?? 8787);
		const host = env.TEAM_HOST ?? "127.0.0.1";
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid TEAM_PORT");
		const server = createServer(async (req, res) => {
			try {
				const chunks: Buffer[] = [];
				let length = 0;
				for await (const chunk of req) {
					const bytes = Buffer.from(chunk);
					length += bytes.length;
					if (length > 4000000) {
						res.writeHead(413);
						res.end();
						return;
					}
					chunks.push(bytes);
				}
				const headers = new Headers();
				for (const [key, value] of Object.entries(req.headers)) {
					if (typeof value === "string") headers.set(key, value);
				}
				const request = new Request(`http://service.internal${req.url ?? "/"}`, {
					method: req.method ?? "GET",
					headers,
					...(length ? { body: Buffer.concat(chunks) } : {}),
				});
				const response = await handler(request);
				res.writeHead(response.status, {
					...Object.fromEntries(response.headers),
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
				});
				res.end(Buffer.from(await response.arrayBuffer()));
			} catch {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end('{"error":"unavailable"}');
			}
		});
		server.requestTimeout = 30000;
		server.headersTimeout = 15000;
		server.maxHeadersCount = 64;
		server.listen(port, host, () => process.stdout.write("team-server listening\n"));
		for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
	} else {
		const deps = dependencies(env);
		const apiKey = required(env, "META_API_KEY");
		const model = new MetaClient({
			getApiKey: async () => apiKey,
			recordUsage: (record) => {
				process.stdout.write(`${JSON.stringify({ type: "model-usage", ...record })}\n`);
			},
		});
		const consumer = new TeamConsumer({
			db: deps.admin,
			github: deps.github,
			analysisVersion: deps.analysisVersion,
			model,
		});
		const controller = new AbortController();
		for (const signal of ["SIGINT", "SIGTERM"] as const)
			process.once(signal, () => controller.abort());
		do {
			try {
				const webhook = await consumer.tick("webhook", controller.signal);
				const preparation = await consumer.tick("preparation", controller.signal);
				if (args.includes("--once")) return;
				if (!webhook && !preparation) await delay(1000, controller.signal);
			} catch {
				process.stderr.write("team-consumer transport unavailable; durable lease retained\n");
				if (args.includes("--once")) throw new Error("Team consumer unavailable");
				await delay(5000, controller.signal);
			}
		} while (!controller.signal.aborted);
	}
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	void main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(
			`${error instanceof Error && error.message.startsWith("Missing required environment:") ? error.message : "Team service failed; check configuration and connectivity"}\n`
		);
		process.exitCode = 1;
	});
