import { z } from "zod";
import { BrowserElementSchema, BrowserViewportSchema } from "./browser";
import { CodeLocationSchema, IdSchema, RepositoryPathSchema } from "./common";
import { LocalBrowserStateSchema } from "./local-browser";
import { ReviewNavigationSchema, ReviewScreenSchema } from "./prepared-review";
import { PullRequestSchema } from "./review";

import {
	CenterSectionSchema,
	CodeFlowSchema,
	HubSnapshotSchema,
	PinnedSourceSchema,
} from "./command-center";
import { WorkspaceUrlSchema } from "./web-url";
export { WorkspaceUrlSchema } from "./web-url";

/** Fixed, safe IPC diagnostic. Never reflect provider text or credential values. */
export const WORKSPACE_GITHUB_REQUIRED =
	"Connect GitHub in Settings, then reopen this pull request.";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const point = z.number().finite().min(-4000).max(8000);
export const VisualSpecSchema = z.strictObject({
	width: z.int().min(200).max(1600),
	height: z.int().min(150).max(1600),
	background: color.default("#ffffff"),
	elements: z
		.array(
			z.discriminatedUnion("kind", [
				z.strictObject({
					kind: z.literal("rect"),
					x: point,
					y: point,
					width: z.number().positive().max(4000),
					height: z.number().positive().max(4000),
					fill: color,
					stroke: color.optional(),
					radius: z.number().min(0).max(200).optional(),
				}),
				z.strictObject({
					kind: z.literal("text"),
					x: point,
					y: point,
					text: z.string().max(500),
					fill: color,
					fontSize: z.number().min(8).max(100),
					weight: z.enum(["normal", "bold"]).optional(),
				}),
				z.strictObject({
					kind: z.literal("line"),
					x: point,
					y: point,
					x2: point,
					y2: point,
					stroke: color,
					width: z.number().positive().max(20).optional(),
				}),
			])
		)
		.max(300),
});
const canvasFields = {
	id: IdSchema,
	title: z.string().trim().min(1).max(120),
	revision: z.int().positive(),
};
export const CanvasSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...canvasFields,
		kind: z.literal("center"),
		section: CenterSectionSchema,
		selectedId: IdSchema.optional(),
	}),
	z.strictObject({ ...canvasFields, kind: z.literal("source"), source: PinnedSourceSchema }),
	z.strictObject({ ...canvasFields, kind: z.literal("flow"), flow: CodeFlowSchema }),
	z.strictObject({ ...canvasFields, kind: z.literal("review") }),
	z.strictObject({ ...canvasFields, kind: z.literal("browser") }),
	z.strictObject({
		...canvasFields,
		kind: z.literal("document"),
		markdown: z.string().max(40000),
		references: z.array(CodeLocationSchema).max(30).default([]),
		provenance: z.literal("agent-draft"),
	}),
	z.strictObject({
		...canvasFields,
		kind: z.literal("visual"),
		visual: VisualSpecSchema,
		references: z.array(CodeLocationSchema).max(30).default([]),
		provenance: z.literal("agent-draft"),
	}),
]);
export const WorkspaceSnapshotSchema = z
	.strictObject({
		sequence: z.int().nonnegative(),
		canvases: z.array(CanvasSchema).min(1).max(12),
		primaryId: IdSchema,
		secondaryId: IdSchema.nullable(),
		review: ReviewScreenSchema,
		codeView: z.enum(["diff", "base", "head"]).default("diff"),
		browser: LocalBrowserStateSchema.nullable(),
		centerSection: CenterSectionSchema.optional(),
	})
	.superRefine((value, ctx) => {
		const ids = value.canvases.map((c) => c.id);
		if (
			new Set(ids).size !== ids.length ||
			!ids.includes(value.primaryId) ||
			(value.secondaryId !== null &&
				(!ids.includes(value.secondaryId) || value.secondaryId === value.primaryId))
		)
			ctx.addIssue({
				code: "custom",
				message: "Canvas identities and displayed panes must be unique and present",
			});
	});
export const WorkspaceBrowserObservationSchema = z.strictObject({
	browserId: IdSchema,
	documentId: IdSchema,
	sequence: z.int().nonnegative(),
	observedAt: z.iso.datetime(),
	url: WorkspaceUrlSchema,
	title: z.string().max(500),
	viewport: BrowserViewportSchema,
	text: z.string().max(16000),
	elements: z.array(BrowserElementSchema.omit({ location: true })).max(150),
	scroll: z.strictObject({ x: z.number().finite(), y: z.number().finite() }),
	presented: z.boolean(),
	truncated: z.boolean(),
	provenance: z.literal("website-unverified-revision"),
});
const observedTarget = { browserId: IdSchema, observationSequence: z.int().nonnegative() };
export const WorkspaceBrowserCommandSchema = z.discriminatedUnion("kind", [
	z.strictObject({ ...observedTarget, kind: z.literal("click"), elementId: IdSchema }),
	z.strictObject({
		...observedTarget,
		kind: z.literal("type"),
		elementId: IdSchema,
		text: z.string().max(4000),
	}),
	z.strictObject({
		...observedTarget,
		kind: z.literal("scroll"),
		elementId: IdSchema.optional(),
		x: z.number().finite().optional(),
		y: z.number().finite().optional(),
	}),
	z.strictObject({ kind: z.literal("viewport"), viewport: BrowserViewportSchema }),
	z.strictObject({ kind: z.enum(["back", "forward", "reload"]) }),
]);
const target = z.enum(["primary", "secondary"]).optional();
export const WorkspaceCommandSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("open-center"),
		section: CenterSectionSchema,
		selectedId: IdSchema.optional(),
	}),
	z.strictObject({ kind: z.literal("open-source"), location: CodeLocationSchema, target }),
	z.strictObject({
		kind: z.literal("create-flow"),
		id: IdSchema.optional(),
		title: z.string().min(1).max(200),
		summary: z.string().max(6000),
		steps: z
			.array(
				z.strictObject({
					title: z.string().max(200),
					explanation: z.string().max(4000),
					location: CodeLocationSchema,
				})
			)
			.min(1)
			.max(20),
		target,
	}),
	z.strictObject({ kind: z.literal("open-browser"), url: WorkspaceUrlSchema, target }),
	z.strictObject({ kind: z.literal("browser-action"), action: WorkspaceBrowserCommandSchema }),
	z.strictObject({ kind: z.literal("show-review"), prId: IdSchema, target }),
	z.strictObject({
		kind: z.literal("navigate-review"),
		direction: z.enum(["start", "next", "previous", "resume", "pause"]).optional(),
		path: RepositoryPathSchema.optional(),
		line: z.int().positive().optional(),
		side: z.enum(["base", "head"]).optional(),
	}),
	z.strictObject({ kind: z.literal("code-view"), view: z.enum(["diff", "base", "head"]) }),
	z.strictObject({
		kind: z.literal("write-document"),
		id: IdSchema.optional(),
		title: z.string().trim().min(1).max(120),
		markdown: z.string().max(40000),
		references: z.array(CodeLocationSchema).max(30).optional(),
		target,
	}),
	z.strictObject({
		kind: z.literal("create-visual"),
		id: IdSchema.optional(),
		title: z.string().trim().min(1).max(120),
		visual: VisualSpecSchema,
		references: z.array(CodeLocationSchema).max(30).optional(),
		target,
	}),
	z.strictObject({ kind: z.literal("focus-canvas"), id: IdSchema, target }),
	z.strictObject({ kind: z.literal("close-canvas"), id: IdSchema }),
	z.strictObject({
		kind: z.literal("layout"),
		primaryId: IdSchema,
		secondaryId: IdSchema.nullable(),
	}),
]);
export const WorkspaceEffectSchema = z
	.strictObject({
		expectedSequence: z.int().nonnegative(),
		snapshot: WorkspaceSnapshotSchema,
		navigation: ReviewNavigationSchema.optional(),
	})
	.refine(
		(effect) => effect.snapshot.sequence === effect.expectedSequence + 1,
		"An effect advances the workspace by exactly one revision"
	);
export const WorkspaceObservationSchema = z.strictObject({
	workspace: WorkspaceSnapshotSchema,
	browser: WorkspaceBrowserObservationSchema.nullable(),
	reviews: z
		.array(
			z.strictObject({
				pr: PullRequestSchema,
				status: z.enum(["queued", "preparing", "ready", "error"]),
				reviewId: IdSchema.optional(),
			})
		)
		.max(200),
	capabilities: z
		.array(z.enum(["documents", "visuals", "browser", "review", "center", "source", "flow"]))
		.max(7),
	hub: HubSnapshotSchema.optional(),
	savedCanvases: z
		.array(z.strictObject({ ...canvasFields, kind: z.enum(["document", "visual", "flow"]) }))
		.max(50)
		.optional(),
});
export type Canvas = z.infer<typeof CanvasSchema>;
export type VisualSpec = z.infer<typeof VisualSpecSchema>;
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;
export type WorkspaceObservation = z.infer<typeof WorkspaceObservationSchema>;
export type WorkspaceCommand = z.infer<typeof WorkspaceCommandSchema>;
export type WorkspaceEffect = z.infer<typeof WorkspaceEffectSchema>;
export type WorkspaceBrowserObservation = z.infer<typeof WorkspaceBrowserObservationSchema>;
export type WorkspaceBrowserCommand = z.infer<typeof WorkspaceBrowserCommandSchema>;
