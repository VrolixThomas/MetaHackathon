import { z } from "zod";
import { BrowserBoundsSchema, BrowserViewportSchema } from "./browser";

export const LocalBrowserUrlSchema = z
	.url()
	.max(4096)
	.refine((value) => {
		const url = new URL(value);
		return (
			url.protocol === "http:" &&
			["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
			!url.username &&
			!url.password
		);
	}, "Use a local HTTP address without credentials");
export const LocalBrowserStateSchema = z.strictObject({
	url: LocalBrowserUrlSchema,
	title: z.string().max(500),
	viewport: BrowserViewportSchema,
	canGoBack: z.boolean(),
	canGoForward: z.boolean(),
	provenance: z.literal("local-preview-unverified-revision"),
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
