import { z } from "zod";
import { CodeLocationSchema, CommitShaSchema, IdSchema, RevisionSchema } from "./common";

export const BrowserViewportSchema = z.strictObject({
	width: z.int().min(320).max(3840),
	height: z.int().min(240).max(2160),
});
export const BrowserBoundsSchema = z.strictObject({
	x: z.number().finite(),
	y: z.number().finite(),
	width: z.number().nonnegative(),
	height: z.number().nonnegative(),
});
export const BrowserElementSchema = z.strictObject({
	id: IdSchema,
	role: z.string().max(100),
	name: z.string().max(500),
	tag: z.string().max(50),
	value: z.string().max(2000).optional(),
	// Viewport CSS pixels. Off-screen elements may have negative coordinates.
	bounds: BrowserBoundsSchema,
	visible: z.boolean(),
	enabled: z.boolean(),
	location: CodeLocationSchema.optional(),
});
export const BrowserStateSchema = z
	.strictObject({
		browserId: IdSchema,
		sessionId: IdSchema,
		prId: IdSchema,
		repository: IdSchema,
		commitSha: CommitShaSchema,
		revision: RevisionSchema,
		url: z.url(),
		title: z.string().max(500),
		viewport: BrowserViewportSchema,
		sequence: z.int().nonnegative(),
		observedAt: z.iso.datetime(),
		text: z.string().max(16000),
		elements: z.array(BrowserElementSchema).max(150),
		scroll: z.strictObject({ x: z.number().finite(), y: z.number().finite() }),
		// This snapshot comes from the visible page, not fixture geometry or a second browser.
		provenance: z.literal("live-browser"),
	})
	.refine(
		(state) => new Set(state.elements.map((item) => item.id)).size === state.elements.length,
		"Browser element IDs must be unique within an observation"
	);

const identity = { sessionId: IdSchema, requestId: IdSchema };
const target = { ...identity, browserId: IdSchema };
const element = { ...target, elementId: IdSchema, observationSequence: z.int().nonnegative() };
export const BrowserCommandSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...identity,
		kind: z.literal("open"),
		prId: IdSchema,
		revision: RevisionSchema,
		path: z.string().max(2000).optional(),
	}),
	z.strictObject({ ...target, kind: z.literal("navigate"), url: z.url() }),
	z.strictObject({ ...element, kind: z.literal("click") }),
	z.strictObject({ ...element, kind: z.literal("type"), text: z.string().max(4000) }),
	z
		.strictObject({
			...target,
			kind: z.literal("scroll"),
			x: z.number().finite().optional(),
			y: z.number().finite().optional(),
			elementId: IdSchema.optional(),
			observationSequence: z.int().nonnegative().optional(),
		})
		.refine(
			(command) =>
				command.elementId
					? command.observationSequence !== undefined
					: command.x !== undefined || command.y !== undefined,
			"Scroll requires coordinates or an element from a known observation"
		),
	z.strictObject({ ...target, kind: z.literal("viewport"), viewport: BrowserViewportSchema }),
]);
export const BrowserObserveInputSchema = z.strictObject({ sessionId: IdSchema });
export const BrowserPresentInputSchema = z.strictObject({
	sessionId: IdSchema,
	// Null hides the native surface while preserving its page and browser session.
	bounds: BrowserBoundsSchema.nullable(),
});
export type BrowserViewport = z.infer<typeof BrowserViewportSchema>;
export type BrowserBounds = z.infer<typeof BrowserBoundsSchema>;
export type BrowserElement = z.infer<typeof BrowserElementSchema>;
export type BrowserState = z.infer<typeof BrowserStateSchema>;
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;
export type BrowserObserveInput = z.infer<typeof BrowserObserveInputSchema>;
export type BrowserPresentInput = z.infer<typeof BrowserPresentInputSchema>;
