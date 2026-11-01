import { receiveWebhook } from "../webhook";
import { type EdgeEnvironment, edgeConfiguration } from "./config";
import { adminDatabase } from "./dependencies";
import {
	type EdgeHandler,
	type EdgePorts,
	functionPath,
	json,
	scopedFetch,
	scopedRequest,
	withinDeadline,
} from "./http";

export function createTeamWebhookHandler(env: EdgeEnvironment, ports: EdgePorts = {}): EdgeHandler {
	const { config, status, ready } = edgeConfiguration(env, "webhook");
	return async (request) => {
		const path = functionPath(request, "muse-team-webhook");
		if (path === "/health" && request.method === "GET")
			return json({ status: ready ? "configured" : "unavailable", ...status }, ready ? 200 : 503);
		if (path !== "/" && path !== "/webhooks/github") return json({ error: "not-found" }, 404);
		if (request.method !== "POST") return json({ error: "method" }, 405, { Allow: "POST" });
		if (!/^sha256=[0-9a-f]{64}$/.test(request.headers.get("x-hub-signature-256") ?? ""))
			return json({ error: "unauthorized" }, 401);
		if (!ready) return json({ error: "configuration", ...status }, 503);
		return withinDeadline(request, ports, (signal) =>
			receiveWebhook(scopedRequest(request, signal), {
				secret: config.webhookSecret,
				db: adminDatabase(config, scopedFetch(signal, ports.fetch)),
			})
		);
	};
}
