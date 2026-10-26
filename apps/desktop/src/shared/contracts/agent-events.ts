import { z } from "zod";
import { JsonValuesSchema, RepositoryPathSchema, SourceReferenceSchema } from "./common";
import { AgentActionSchema, type TurnIdentity, TurnIdentitySchema } from "./interaction";
import { PullRequestSchema } from "./review";

function sameTurn(left: TurnIdentity, right: TurnIdentity): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.turnId === right.turnId &&
		left.generation === right.generation
	);
}

const eventFields = {
	...TurnIdentitySchema.shape,
	// Sequences start at one and are scoped to this exact turn identity.
	sequence: z.int().positive(),
};
export const AgentEventSchema = z
	.discriminatedUnion("kind", [
		z.strictObject({ ...eventFields, kind: z.literal("acknowledgement"), text: z.string().min(1) }),
		z.strictObject({ ...eventFields, kind: z.literal("text-delta"), delta: z.string() }),
		z.strictObject({ ...eventFields, kind: z.literal("action"), action: AgentActionSchema }),
		z.strictObject({ ...eventFields, kind: z.literal("completed") }),
		z.strictObject({ ...eventFields, kind: z.literal("cancelled") }),
		z.strictObject({ ...eventFields, kind: z.literal("error"), message: z.string().min(1) }),
	])
	.refine((event) => event.kind !== "action" || sameTurn(event, event.action), {
		message: "Action identity must match its event",
		path: ["action"],
	});

export const AgentTurnStatusSchema = z.enum(["running", "completed", "cancelled", "error"]);
export const MAX_AGENT_EVENTS_PER_POLL = 100;
export const PollTurnSchema = z.strictObject({
	...TurnIdentitySchema.shape,
	afterSequence: z.int().nonnegative().default(0),
	limit: z.int().positive().max(MAX_AGENT_EVENTS_PER_POLL).default(MAX_AGENT_EVENTS_PER_POLL),
});

export const PollTurnResultSchema = z
	.strictObject({
		...TurnIdentitySchema.shape,
		status: z.enum([...AgentTurnStatusSchema.options, "stale"]),
		// Latest emitted sequence, not the page cursor. Advance from the last returned event.
		sequence: z.int().nonnegative(),
		events: z.array(AgentEventSchema).max(MAX_AGENT_EVENTS_PER_POLL),
		// Full snapshots at `sequence` allow recovery when earlier events have been compacted.
		text: z.string(),
		actions: z.array(AgentActionSchema),
	})
	.superRefine((result, ctx) => {
		let previousSequence = 0;
		for (const [index, event] of result.events.entries()) {
			if (!sameTurn(result, event)) {
				ctx.addIssue({
					code: "custom",
					path: ["events", index],
					message: "Event identity must match the polled turn",
				});
			}
			if (event.sequence <= previousSequence || event.sequence > result.sequence) {
				ctx.addIssue({
					code: "custom",
					path: ["events", index, "sequence"],
					message: "Events must be ordered, unique and no newer than the snapshot",
				});
			}
			previousSequence = event.sequence;
			if (
				(event.kind === "completed" || event.kind === "cancelled" || event.kind === "error") &&
				(event.kind !== result.status || event.sequence !== result.sequence)
			) {
				ctx.addIssue({
					code: "custom",
					path: ["events", index],
					message: "Terminal event must match the final status and sequence",
				});
			}
		}
		for (const [index, action] of result.actions.entries()) {
			if (!sameTurn(result, action)) {
				ctx.addIssue({
					code: "custom",
					path: ["actions", index],
					message: "Snapshot action identity must match the polled turn",
				});
			}
		}
		if (
			result.status === "stale" &&
			(result.sequence !== 0 ||
				result.events.length !== 0 ||
				result.text !== "" ||
				result.actions.length !== 0)
		) {
			ctx.addIssue({ code: "custom", message: "Stale polls must not return another turn's data" });
		}
	});

export const ScenarioOriginSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("ticket"),
		criterion: z.string().min(1),
		source: SourceReferenceSchema.refine(
			(source) => source.kind === "ticket",
			"Ticket scenarios require a ticket citation"
		),
	}),
	z.strictObject({
		kind: z.literal("reviewer"),
		requestId: z.string().min(1),
		originalWords: z.string().min(1),
	}),
	z.strictObject({ kind: z.literal("agent"), rationale: z.string().min(1) }),
]);

// Mirrors the agent's data-driven test plan; generation is not an execution result.
export const ScenarioPlanSchema = z.strictObject({
	id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
	pr: PullRequestSchema,
	title: z.string().min(1).max(500),
	origin: ScenarioOriginSchema,
	inputs: JsonValuesSchema,
	modulePath: RepositoryPathSchema.refine((path) => /\.(ts|js|mjs)$/.test(path)),
	exportName: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
	// Runtime resolves this unique inspected source anchor independently on each pinned revision.
	anchor: z.string().min(1).max(300),
	arguments: z.array(z.json()).max(20),
	expectation: z.strictObject({
		path: z
			.array(z.union([z.string().max(100), z.int().nonnegative()]))
			.min(1)
			.max(20)
			.refine(
				(path) =>
					path.every((key) => key !== "__proto__" && key !== "constructor" && key !== "prototype"),
				"Unsafe expectation path"
			),
		equals: z.json(),
		description: z.string().min(1),
	}),
});
export const GeneratedScenarioSchema = z.strictObject({
	plan: ScenarioPlanSchema,
	filename: RepositoryPathSchema.refine((path) => path.endsWith(".mjs"), "Expected an .mjs test"),
	source: z.string().min(1),
	// The agent verifies this digest against the source before requesting runtime execution.
	sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
	// Origin citations describe provenance, even if they cite a prior run of another test.
	execution: z.literal("not-run"),
});

export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentTurnStatus = z.infer<typeof AgentTurnStatusSchema>;
export type PollTurn = z.infer<typeof PollTurnSchema>;
export type PollTurnResult = z.infer<typeof PollTurnResultSchema>;
export type ScenarioOrigin = z.infer<typeof ScenarioOriginSchema>;
export type ScenarioPlan = z.infer<typeof ScenarioPlanSchema>;
export type GeneratedScenario = z.infer<typeof GeneratedScenarioSchema>;
