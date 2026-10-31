import { z } from "zod";
import { probeMuseCode, runMuseCodeTask } from "../index";
import { dependencies } from "../protocol";
import type { AcceptancePorts, Audit } from "./runner";

const id = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9-]+$/);
const terminalSchema = z.object({
	session: z.object({ sessionId: id }),
	lastTurn: z
		.object({ turnId: id, terminal: z.enum(["completed", "failed", "cancelled"]) })
		.optional(),
});
const acknowledgement = z.object({ commandId: id, turnId: id, status: z.literal("accepted") });

/** Transparent observation only: all live operations use the existing real production adapter. */
export function livePorts(): AcceptancePorts {
	return {
		transport: "live-subscription",
		probe: (musePath, signal) => probeMuseCode({ musePath }, signal),
		run: (input, musePath, signal, audit: Audit) =>
			runMuseCodeTask(input, { musePath, log: async () => {}, redact: (text) => text }, signal, {
				async connect(...args) {
					const host = await dependencies.connect(...args);
					audit.hostsOpened++;
					let closed = false;
					return {
						...host,
						async start(options) {
							const session = await host.start(options);
							audit.starts.push(session.sessionId);
							return session;
						},
						async resume(options) {
							const session = await host.resume(options);
							audit.resumes.push(session.sessionId);
							return session;
						},
						async command(method, params, commandId) {
							const result = await host.command(method, params, commandId);
							if (method === "turn/start" || method === "turn/cancel") {
								const observed = acknowledgement.safeParse(result);
								if (observed.success && typeof params["sessionId"] === "string") {
									const identity = {
										sessionId: id.parse(params["sessionId"]),
										turnId: observed.data.turnId,
										commandId: observed.data.commandId,
									};
									if (method === "turn/start" && observed.data.status === "accepted")
										audit.turnStarts.push(identity);
									if (method === "turn/cancel")
										audit.cancels.push({ ...identity, status: observed.data.status });
								}
							}
							return result;
						},
						async request(method, params) {
							const result = await host.request(method, params);
							if (method === "session/read") {
								const observed = terminalSchema.safeParse(result);
								if (observed.success && observed.data.lastTurn) {
									const item = {
										sessionId: observed.data.session.sessionId,
										...observed.data.lastTurn,
									};
									if (
										!audit.terminals.some(
											(prior) =>
												prior.sessionId === item.sessionId &&
												prior.turnId === item.turnId &&
												prior.terminal === item.terminal
										)
									)
										audit.terminals.push(item);
								}
							}
							return result;
						},
						async close() {
							await host.close();
							if (!closed) {
								closed = true;
								audit.hostsClosed++;
							}
						},
					};
				},
			}),
	};
}
