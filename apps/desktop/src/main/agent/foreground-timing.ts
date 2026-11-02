import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentModelClient } from "./meta-client";

// Fixed allowlist, independent of provider strings. Unknown/unexposed tool names
// never become log labels, even when the model returns malicious function output.
const operation = z.enum([
	"workspace-observe",
	"hub-observe",
	"current-context",
	"prefill-ticket",
	"prefill-job",
	"model",
	"workspace-execute-including-receipt",
	"other-registered-tool",
	"inspect_ticket",
	"inspect_hub",
	"inspect_work_job",
	"inspect_work_review",
	"inspect_work_log",
	"start_work",
	"pause_work",
	"resume_work",
	"cancel_work",
	"open_command_center",
	"browse_command_center",
	"inspect_workspace",
	"open_ready_review",
	"expand_tools",
	"analyze_current_context",
	"queue_notice_announcement",
	"narration-receipt",
]);
export const ForegroundTimingSchema = z.strictObject({
	stage: z.literal("foreground-timing"),
	turnHash: z.string().regex(/^[a-f0-9]{64}$/),
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
	operation,
	sequence: z.int().nonnegative(),
	status: z.enum(["completed", "failed", "cancelled"]),
	durationMs: z.number().nonnegative().max(3_600_000),
	firstTextMs: z.number().nonnegative().max(3_600_000).nullable(),
});
export type ForegroundTiming = z.infer<typeof ForegroundTimingSchema>;
export class ForegroundTrace {
	private sequence = 0;
	private readonly turnHash: string;
	constructor(
		private requestId: string,
		identity: { sessionId: string; turnId: string; generation: number },
		private sink?: (event: ForegroundTiming) => void
	) {
		this.turnHash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
	}
	private record(
		name: string,
		requestId: string,
		sequence: number,
		start: number,
		status: ForegroundTiming["status"],
		firstTextMs: number | null = null
	) {
		try {
			this.sink?.(
				ForegroundTimingSchema.parse({
					stage: "foreground-timing",
					turnHash: this.turnHash,
					requestHash: createHash("sha256").update(requestId).digest("hex"),
					operation: operation.safeParse(name).success ? name : "other-registered-tool",
					sequence,
					status,
					durationMs: Math.round(performance.now() - start),
					firstTextMs,
				})
			);
		} catch {
			/* Observability never changes foreground behavior. */
		}
	}
	async measure<T>(name: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
		const sequence = this.sequence++;
		const start = performance.now();
		try {
			const value = await fn();
			this.record(
				name,
				this.requestId,
				sequence,
				start,
				signal.aborted ? "cancelled" : "completed"
			);
			return value;
		} catch (error) {
			this.record(name, this.requestId, sequence, start, signal.aborted ? "cancelled" : "failed");
			throw error;
		}
	}
	client(client: AgentModelClient): AgentModelClient {
		const trace = this;
		return {
			async *stream(request, signal) {
				const sequence = trace.sequence++;
				const start = performance.now();
				let firstTextMs: number | null = null;
				let status: ForegroundTiming["status"] = "failed";
				try {
					for await (const event of client.stream(request, signal)) {
						if (event.type === "text" && firstTextMs === null)
							firstTextMs = Math.round(performance.now() - start);
						if (event.type === "completed") status = "completed";
						yield event;
					}
				} finally {
					trace.record(
						"model",
						request.requestId,
						sequence,
						start,
						signal.aborted ? "cancelled" : status,
						firstTextMs
					);
				}
			},
		};
	}
}
