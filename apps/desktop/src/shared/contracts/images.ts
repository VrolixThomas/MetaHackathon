import { z } from "zod";
import { IdSchema } from "./common";

export const ImageAssetSchema = z.strictObject({
	id: IdSchema.max(200),
	title: z.string().trim().min(1).max(120),
	mime: z.enum(["image/png", "image/jpeg"]),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	width: z.int().positive().max(4096),
	height: z.int().positive().max(4096),
	byteLength: z
		.int()
		.positive()
		.max(12 * 1024 * 1024),
	createdAt: z.iso.datetime(),
	provenance: z.literal("provider-generated"),
	provider: z.string().min(1).max(80),
	model: z.string().min(1).max(120),
});
export const GenerateImageInputSchema = z.strictObject({
	requestId: IdSchema.max(200),
	title: z.string().trim().min(1).max(120),
	prompt: z.string().trim().min(1).max(12000),
});
export const ImageReadResultSchema = z.strictObject({
	asset: ImageAssetSchema,
	dataUrl: z
		.string()
		.max(17 * 1024 * 1024)
		.regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/),
});
export type ImageAsset = z.infer<typeof ImageAssetSchema>;
export type GenerateImageInput = z.infer<typeof GenerateImageInputSchema>;
export type ImageReadResult = z.infer<typeof ImageReadResultSchema>;
