import { z } from "zod";

/** Main-only execution identity. Missing historical metadata always means the legacy pair. */
export const CodingModelSchema = z.discriminatedUnion("model", [
	z.strictObject({ model: z.literal("muse-spark-1.3"), reasoning: z.literal("minimal") }),
	z.strictObject({ model: z.literal("muse-wonder-1.0"), reasoning: z.literal("high") }),
]);
export type CodingModel = z.infer<typeof CodingModelSchema>;
export const LEGACY_CODING_MODEL: CodingModel = Object.freeze({
	model: "muse-spark-1.3",
	reasoning: "minimal",
});
export const NEW_CODING_MODEL: CodingModel = Object.freeze({
	model: "muse-wonder-1.0",
	reasoning: "high",
});
export function sameCodingModel(a: CodingModel, b: CodingModel): boolean {
	return a.model === b.model && a.reasoning === b.reasoning;
}
