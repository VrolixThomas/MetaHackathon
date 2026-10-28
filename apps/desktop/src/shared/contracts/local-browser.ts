import { z } from "zod";
import { BrowserBoundsSchema, BrowserViewportSchema } from "./browser";

import { WorkspaceUrlSchema } from "./web-url";

/** Legacy transport name; workspace canvases also support public HTTPS pages. */
export const LocalBrowserUrlSchema = WorkspaceUrlSchema;
export const LocalBrowserViewportModeSchema = z.enum(["desktop", "phone", "fixed"]);
export const LocalBrowserStateSchema = z.strictObject({
	url: LocalBrowserUrlSchema,
	title: z.string().max(500),
	viewport: BrowserViewportSchema,
	// Desktop follows the visible pane; phone/custom viewports retain explicit emulated dimensions.
	viewportMode: LocalBrowserViewportModeSchema.optional(),
	canGoBack: z.boolean(),
	canGoForward: z.boolean(),
	provenance: z.enum(["local-preview-unverified-revision", "website-unverified-revision"]),
});
export const LocalBrowserPresentSchema = z.strictObject({
	bounds: BrowserBoundsSchema.nullable(),
	viewport: BrowserViewportSchema.optional(),
});
export const LocalBrowserCommandSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("navigate"), url: LocalBrowserUrlSchema }),
	z.strictObject({ kind: z.enum(["back", "forward", "reload"]) }),
]);
export type LocalBrowserState = z.infer<typeof LocalBrowserStateSchema>;
export type LocalBrowserCommand = z.infer<typeof LocalBrowserCommandSchema>;
export type LocalBrowserPresent = z.infer<typeof LocalBrowserPresentSchema>;
export type LocalBrowserViewportMode = z.infer<typeof LocalBrowserViewportModeSchema>;
