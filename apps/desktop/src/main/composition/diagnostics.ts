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
import { ForegroundTimingSchema } from "../agent/foreground-timing";
import type { ModelTimingRecord } from "../agent/meta-client";
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
const count = z.int().nonnegative().max(2_147_483_647);
const milliseconds = z.number().nonnegative().max(3_600_000);
const modelTiming = z.strictObject({
	stage: z.literal("model-timing"),
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
	attemptHash: z.string().regex(/^[a-f0-9]{64}$/),
	workload: z.enum(["quick", "deep"]),
	status: z.enum(["completed", "failed", "incomplete", "cancelled", "interrupted"]),
	inputBytes: count,
	instructionBytes: count,
	toolBytes: count,
	inputItems: count,
	toolCount: count,
	maxOutputTokens: count,
	requestBytes: count.nullable(),
	credentialMs: milliseconds.nullable(),
	headersMs: milliseconds.nullable(),
	firstEventMs: milliseconds.nullable(),
	firstTextMs: milliseconds.nullable(),
	terminalMs: milliseconds.nullable(),
	durationMs: milliseconds,
	streamedTextChars: count,
	functionCalls: count.nullable(),
	httpStatus: z.int().min(100).max(599).nullable(),
	inputTokens: count.nullable(),
	cachedInputTokens: count.nullable(),
	outputTokens: count.nullable(),
});
const eventSchema = z.union([
	ConversationDiagnosticSchema,
	lifecycle,
	modelTiming,
	ForegroundTimingSchema,
]);

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
	recordModelTiming(record: ModelTimingRecord): void {
		this.record({ ...record, stage: "model-timing" });
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
