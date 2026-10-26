import { z } from "zod";
import {
	CodeLocationSchema,
	CommitShaSchema,
	EvidenceSchema,
	IdSchema,
	JsonValuesSchema,
	RevisionSchema,
	RunEvidenceSchema,
} from "./common";

export const ScenarioRequestSchema = z.strictObject({
	requestId: IdSchema,
	prId: IdSchema,
	title: z.string().min(1),
	inputs: JsonValuesSchema,
	timeoutMs: z.int().positive().max(120_000),
});
export const ScenarioStepSchema = z.strictObject({
	id: IdSchema,
	label: z.string().min(1),
	location: CodeLocationSchema,
	values: JsonValuesSchema,
	outcome: z.enum(["continue", "return", "throw", "stopped"]),
});
export const ScenarioRunSchema = z
	.strictObject({
		revision: RevisionSchema,
		commitSha: CommitShaSchema,
		status: z.enum(["completed", "failed", "timed-out", "cancelled"]),
		steps: z.array(ScenarioStepSchema),
		evidence: RunEvidenceSchema,
	})
	.superRefine((run, ctx) => {
		if (
			run.steps.some(
				(step) =>
					step.location.revision !== run.revision || step.location.commitSha !== run.commitSha
			) ||
			(run.evidence.kind === "execution" && run.evidence.commitSha !== run.commitSha)
		) {
			ctx.addIssue({
				code: "custom",
				message: "Trace locations/evidence must match the run revision",
			});
		}
		if (new Set(run.steps.map((step) => step.id)).size !== run.steps.length) {
			ctx.addIssue({ code: "custom", message: "Trace step IDs must be unique within each run" });
		}
	});
export const ScenarioTraceSchema = z
	.strictObject({
		id: IdSchema,
		prId: IdSchema,
		title: z.string().min(1),
		inputs: JsonValuesSchema,
		before: ScenarioRunSchema,
		after: ScenarioRunSchema,
		// Zero-based index into both step arrays; absent if no known divergence.
		divergenceIndex: z.int().nonnegative().optional(),
	})
	.refine(
		(trace) =>
			trace.before.revision === "base" &&
			trace.after.revision === "head" &&
			(trace.divergenceIndex === undefined ||
				trace.divergenceIndex < Math.min(trace.before.steps.length, trace.after.steps.length)),
		"Expected base/head traces and an in-range divergence index"
	);

export const DiagramSpecSchema = z
	.strictObject({
		id: IdSchema,
		prId: IdSchema,
		title: z.string().min(1),
		nodes: z
			.array(
				z.strictObject({ id: IdSchema, label: z.string().min(1), location: CodeLocationSchema })
			)
			.min(1),
		edges: z.array(z.strictObject({ from: IdSchema, to: IdSchema, label: z.string().optional() })),
		evidence: EvidenceSchema,
	})
	.refine((diagram) => {
		const ids = new Set(diagram.nodes.map((node) => node.id));
		return (
			ids.size === diagram.nodes.length &&
			diagram.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))
		);
	}, "Diagram node IDs must be unique and edges must reference existing nodes");

export const PreviewMarkerSchema = z.strictObject({
	id: IdSchema,
	number: z.int().positive(),
	label: z.string().min(1),
	location: CodeLocationSchema,
	// Document CSS pixels (not device pixels); subtract scroll position when drawing overlays.
	bounds: z.strictObject({
		x: z.number().nonnegative(),
		y: z.number().nonnegative(),
		width: z.number().positive(),
		height: z.number().positive(),
	}),
});
export const PreviewSchema = z
	.strictObject({
		id: IdSchema,
		prId: IdSchema,
		revision: RevisionSchema,
		commitSha: CommitShaSchema,
		url: z.url().refine((value) => {
			const url = new URL(value);
			return (
				["http:", "https:"].includes(url.protocol) &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
				!url.username &&
				!url.password
			);
		}, "Preview must use a local HTTP(S) server"),
		viewport: z.strictObject({
			mode: z.enum(["phone", "desktop"]),
			width: z.int().positive(),
			height: z.int().positive(),
		}),
		markers: z.array(PreviewMarkerSchema),
		evidence: RunEvidenceSchema,
	})
	.refine(
		(preview) =>
			new Set(preview.markers.map((marker) => marker.id)).size === preview.markers.length &&
			new Set(preview.markers.map((marker) => marker.number)).size === preview.markers.length &&
			preview.markers.every(
				(marker) =>
					marker.location.revision === preview.revision &&
					marker.location.commitSha === preview.commitSha
			) &&
			(preview.evidence.kind !== "execution" || preview.evidence.commitSha === preview.commitSha),
		"Preview marker IDs/numbers must be unique and locations/evidence must match its revision"
	);

export type ScenarioRequest = z.infer<typeof ScenarioRequestSchema>;
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;
export type ScenarioRun = z.infer<typeof ScenarioRunSchema>;
export type ScenarioTrace = z.infer<typeof ScenarioTraceSchema>;
export type DiagramSpec = z.infer<typeof DiagramSpecSchema>;
export type PreviewMarker = z.infer<typeof PreviewMarkerSchema>;
export type Preview = z.infer<typeof PreviewSchema>;
