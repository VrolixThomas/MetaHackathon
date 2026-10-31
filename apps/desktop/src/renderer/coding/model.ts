import {
	type CodingProviderSettings,
	CodingProviderSettingsSchema,
	type CodingProviderStatus,
	type MuseCodeStatus,
} from "../../shared/contracts/coding-provider";

export const CODING_ERRORS = {
	status: "Coding provider status could not be checked. Refresh to try again.",
	configure: "The saved selection could not be confirmed. Refresh before trying again.",
	login: "Muse Code sign-in could not be opened. Check the CLI status and try again.",
	path: "Enter an absolute CLI executable path starting with /, or leave it blank for Auto.",
	timeout: "The provider check timed out. Refresh to check its actual state.",
} as const;
export const MUSE_CODE_ERRORS: Record<NonNullable<MuseCodeStatus["error"]>, string> = {
	"not-installed":
		"Muse Code was not found. Check the CLI path or install the official CLI separately.",
	"sign-in-required": "Sign in to your existing Muse Code account, then refresh status.",
	"api-key-selected":
		"An API key overrides the Muse Code account. Switch the CLI to subscription sign-in, then refresh.",
	"subscription-required":
		"A Muse Code subscription is required for this selection. Check your CLI account and plan.",
	"quota-exceeded":
		"Muse Code quota is blocked. Check your account limits and refresh when available.",
	"unsupported-cli":
		"This Muse Code CLI is unsupported. Update the official CLI separately, then refresh.",
	unavailable: "Muse Code availability could not be verified. Refresh to try again.",
};
export function parseCodingSettings(input: CodingProviderSettings): CodingProviderSettings {
	const settings = CodingProviderSettingsSchema.parse({
		...input,
		musePath: input.musePath?.trim() ? input.musePath : null,
	});
	if (
		settings.musePath !== null &&
		(!settings.musePath.startsWith("/") ||
			Array.from(settings.musePath).some(
				(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
			))
	)
		throw new Error("Invalid CLI executable path");
	return settings;
}
export function sameSettings(a: CodingProviderSettings | null, b: CodingProviderSettings | null) {
	return a?.provider === b?.provider && a?.musePath === b?.musePath;
}
/** Readiness never substitutes API billing for an unknown or blocked subscription account. */
export function codingReady(status: CodingProviderStatus | null) {
	if (!status?.ready) return false;
	if (status.settings.provider === "meta-api") return status.metaApiConfigured;
	const cli = status.museCode;
	return (
		cli.installed &&
		cli.ready &&
		cli.auth === "account" &&
		cli.billing === "subscription" &&
		cli.error === null
	);
}
export function museIssue(cli: MuseCodeStatus): string | null {
	if (cli.error) return MUSE_CODE_ERRORS[cli.error];
	if (!cli.installed) return MUSE_CODE_ERRORS["not-installed"];
	if (cli.auth === "api-key") return MUSE_CODE_ERRORS["api-key-selected"];
	if (cli.auth === "sign-in-required") return MUSE_CODE_ERRORS["sign-in-required"];
	if (cli.auth === "unknown" || cli.billing === "unknown")
		return "Muse Code account or billing status is unknown. Refresh to verify readiness.";
	if (cli.billing !== "subscription") return MUSE_CODE_ERRORS["subscription-required"];
	if (!cli.ready) return MUSE_CODE_ERRORS.unavailable;
	return null;
}
// Metadata is displayed only as a public label, never as an arbitrary backend frame.
export function publicVersion(value: string | null) {
	return value && /^v?\d+\.\d+\.\d+$/.test(value) ? value : "Unknown";
}
export function publicTier(value: string | null) {
	const tiers = [
		"free",
		"plus",
		"pro",
		"max",
		"team",
		"business",
		"enterprise",
		"standard",
		"premium",
	];
	return value && tiers.includes(value.toLowerCase()) ? value : "Not reported";
}
