import { createTeamApi } from "../api";
import { type EdgeEnvironment, edgeConfiguration } from "./config";
import { apiDependencies } from "./dependencies";
import {
	type EdgeHandler,
	type EdgePorts,
	functionPath,
	json,
	scopedFetch,
	scopedRequest,
	withinDeadline,
} from "./http";

const paths = new Set([
	"/v1/organizations",
	"/v1/organizations/create",
	"/v1/repositories",
	"/v1/repositories/resolve",
	"/v1/repositories/register",
	"/v1/reviews/read",
	"/v1/reviews/status",
	"/v1/reviews/retry",
	"/v1/reviews/request",
	"/v1/progress/read",
	"/v1/progress/write",
	"/v1/proposals/browse",
	"/v1/proposals/get",
	"/v1/proposals/list",
	"/v1/proposals/read",
	"/v1/proposals/authorize-apply",
	"/v1/proposals/share",
	"/v1/proposals/decide",
]);

export function createTeamApiHandler(env: EdgeEnvironment, ports: EdgePorts = {}): EdgeHandler {
	const { config, status, ready } = edgeConfiguration(env, "api");
	return async (request) => {
		const path = functionPath(request, "muse-team-api");
		if (path === "/health" && request.method === "GET")
			return json({ status: ready ? "configured" : "unavailable", ...status }, ready ? 200 : 503);
		if (!paths.has(path)) return json({ error: "not-found" }, 404);
		if (request.method !== "POST") return json({ error: "method" }, 405, { Allow: "POST" });
		// Reject anonymous actions even when configuration is missing. Never substitute gateway JWT auth.
		if (
			!/^Bearer [^\s]{1,32768}$/.test(request.headers.get("authorization") ?? "") ||
			!request.headers.get("x-github-token") ||
			(request.headers.get("x-github-token")?.length ?? 0) > 32768
		)
			return json({ error: "unauthorized" }, 401);
		if (!ready) return json({ error: "configuration", ...status }, 503);
		return withinDeadline(request, ports, async (signal) => {
			const deps = apiDependencies(config, scopedFetch(signal, ports.fetch));
			return createTeamApi(deps.access, deps)(scopedRequest(request, signal, path));
		});
	};
}
