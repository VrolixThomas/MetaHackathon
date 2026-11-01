import { createHash, timingSafeEqual } from "node:crypto";
import type { UsageRecord } from "../../../apps/desktop/src/main/agent/meta-client";
import { type EdgeEnvironment, edgeConfiguration } from "./config";
import { type ConsumerFactory, workerConsumer } from "./dependencies";
import {
	type EdgeHandler,
	type EdgePorts,
	functionPath,
	json,
	scopedFetch,
	smallJson,
	withinDeadline,
} from "./http";

export interface WorkerPorts extends EdgePorts {
	createConsumer?: ConsumerFactory;
	recordUsage?: (record: UsageRecord) => void;
	waitUntil?: (pending: Promise<unknown>) => void;
	/** Fixed numeric outcome only; the database remains the durable work ledger. */
	recordOutcome?: (httpStatus: number) => void;
}

function authorized(request: Request, secret: string): boolean {
	const supplied = /^Bearer ([^\s]{1,4096})$/.exec(request.headers.get("authorization") ?? "")?.[1];
	if (!supplied || !secret) return false;
	// Fixed-size digests keep the equality check constant-time for every accepted header length.
	return timingSafeEqual(
		createHash("sha256").update(supplied, "utf8").digest(),
		createHash("sha256").update(secret, "utf8").digest()
	);
}

export function createTeamWorkerHandler(
	env: EdgeEnvironment,
	ports: WorkerPorts = {}
): EdgeHandler {
	const { config, status, ready } = edgeConfiguration(env, "worker");
	return async (request) => {
		const startedAt = performance.now();
		const path = functionPath(request, "muse-team-worker");
		if (path === "/health" && request.method === "GET")
			return json({ status: ready ? "configured" : "unavailable", ...status }, ready ? 200 : 503);
		if (path !== "/") return json({ error: "not-found" }, 404);
		if (request.method !== "POST") return json({ error: "method" }, 405, { Allow: "POST" });
		if (!config.workerSecret) return json({ error: "configuration", ...status }, 503);
		if (!authorized(request, config.workerSecret)) return json({ error: "unauthorized" }, 401);
		if (!ready) return json({ error: "configuration", ...status }, 503);
		if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
			return json({ error: "content-type" }, 415);
		return withinDeadline(request, ports, async (signal, maxRunMs) => {
			let body: unknown;
			try {
				body = await smallJson(request, signal);
			} catch {
				signal.throwIfAborted();
				return json({ error: "invalid-body", limitBytes: 1024 }, 400);
			}
			if (
				!body ||
				typeof body !== "object" ||
				Object.keys(body).length !== 1 ||
				!("queue" in body) ||
				(body.queue !== "webhook" && body.queue !== "preparation")
			)
				return json({ error: "invalid-queue" }, 400);
			signal.throwIfAborted();
			const queue = body.queue;
			const remainingMs = Math.floor(maxRunMs - (performance.now() - startedAt));
			if (remainingMs < 1) return json({ error: "deadline" }, 504);
			const runTick = async (tickSignal: AbortSignal, budget: number) => {
				tickSignal.throwIfAborted();
				const consumer = workerConsumer(
					config,
					scopedFetch(tickSignal, ports.fetch),
					budget,
					ports.createConsumer,
					ports.recordUsage
				);
				const claimed = await consumer.tick(queue, tickSignal);
				tickSignal.throwIfAborted();
				// tick(true) includes failed/retained claims; it is never completion proof.
				return json({ status: claimed ? "attempted" : "idle", queue });
			};
			if (!ports.waitUntil) return runTick(signal, remainingMs);
			const admission = new AbortController();
			// Accepted durable work survives the HTTP caller disconnecting. Shutdown still aborts it.
			const background = withinDeadline(
				new Request(request.url, { signal: admission.signal }),
				{ ...ports, maxRunMs: remainingMs },
				runTick
			);
			try {
				ports.waitUntil(background.then((result) => ports.recordOutcome?.(result.status)));
			} catch {
				admission.abort();
				return json({ error: "unavailable" }, 503);
			}
			return json({ status: "accepted", queue }, 202);
		});
	};
}
