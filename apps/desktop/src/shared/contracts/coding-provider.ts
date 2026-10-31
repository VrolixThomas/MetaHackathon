import { z } from "zod";

export const CodingProviderSchema = z.enum(["meta-api", "muse-code"]);
export const CodingProviderSettingsSchema = z.strictObject({
	provider: CodingProviderSchema,
	musePath: z.string().min(1).max(4096).nullable(),
});
/** Presence and account/billing metadata only. Never return a CLI credential or raw protocol frame. */
export const MuseCodeStatusSchema = z.strictObject({
	installed: z.boolean(),
	version: z.string().max(100).nullable(),
	auth: z.enum(["account", "api-key", "sign-in-required", "unknown"]),
	billing: z.enum(["subscription", "pay-as-you-go", "unknown"]),
	tier: z.string().max(100).nullable(),
	ready: z.boolean(),
	error: z
		.enum([
			"not-installed",
			"sign-in-required",
			"api-key-selected",
			"subscription-required",
			"quota-exceeded",
			"unsupported-cli",
			"unavailable",
		])
		.nullable(),
});
export const CodingProviderStatusSchema = z.strictObject({
	settings: CodingProviderSettingsSchema,
	metaApiConfigured: z.boolean(),
	museCode: MuseCodeStatusSchema,
	ready: z.boolean(),
});
export type CodingProvider = z.infer<typeof CodingProviderSchema>;
export type CodingProviderSettings = z.infer<typeof CodingProviderSettingsSchema>;
export type MuseCodeStatus = z.infer<typeof MuseCodeStatusSchema>;
export type CodingProviderStatus = z.infer<typeof CodingProviderStatusSchema>;
