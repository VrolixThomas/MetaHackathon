import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ConversationDiagnosticSchema } from "../../shared/contracts";
import { publicProcedure, router } from "../trpc";

const lifecycle = z.strictObject({
	stage: z.enum([
		"app-start",
		"shutdown-start",
		"shutdown-complete",
		"renderer-exit",
		"browser-exit",
		"main-exception",
	]),
	reason: z
		.enum([
			"clean-exit",
			"abnormal-exit",
			"killed",
			"crashed",
			"oom",
			"launch-failed",
			"integrity-failure",
			"memory-eviction",
			"unknown",
		])
		.optional(),
	exitCode: z.int().optional(),
});
const eventSchema = z.union([ConversationDiagnosticSchema, lifecycle]);

/** Bounded private local log. Logging must never fail or delay a voice turn on disk errors. */
export class ConversationDiagnostics {
	readonly path: string;
	private readonly directory: string;
	private windowAt = 0;
	private count = 0;
	constructor(
		userDataPath: string,
		private maxBytes = 256_000
	) {
		this.directory = join(userDataPath, "diagnostics");
		this.path = join(this.directory, "conversation.jsonl");
	}
	record(raw: unknown): void {
		try {
			const result = eventSchema.safeParse(raw);
			if (!result.success) return;
			const now = Date.now();
			if (now - this.windowAt >= 1000) {
				this.windowAt = now;
				this.count = 0;
			}
			if (++this.count > 80) return;
			const event = result.data;
			const { turn, ...metadata } = "turn" in event ? event : { ...event, turn: undefined };
			const line = `${JSON.stringify({
				at: new Date(now).toISOString(),
				...metadata,
				...(turn
					? { turnHash: createHash("sha256").update(JSON.stringify(turn)).digest("hex") }
					: {}),
			})}\n`;
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			if (
				existsSync(this.path) &&
				statSync(this.path).size + Buffer.byteLength(line) > this.maxBytes
			) {
				rmSync(`${this.path}.previous`, { force: true });
				renameSync(this.path, `${this.path}.previous`);
			}
			appendFileSync(this.path, line, { mode: 0o600 });
			chmodSync(this.path, 0o600);
		} catch {
			/* Diagnostics are best-effort and never interrupt application behavior. */
		}
	}
}

export function createDiagnosticsRouter(getLog: () => ConversationDiagnostics | undefined) {
	return router({
		record: publicProcedure
			.input(ConversationDiagnosticSchema)
			.output(z.void())
			.mutation(({ input }) => {
				getLog()?.record(input);
			}),
	});
}
