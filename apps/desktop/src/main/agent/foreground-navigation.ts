import type { WorkspaceObservation } from "../../shared/contracts";

/** Actual user ingress only. Exact UI requests; no source text, model output or write authority. */
export function explicitWorkspaceNavigation(text: string, observed?: WorkspaceObservation) {
	const request = text.trim().replace(/\s+/g, " ");
	if (
		observed?.capabilities.includes("center") &&
		/^(?:(?:please|can you|could you) )?(?:(?:bring|take) me(?: over)? to|(?:open|show)(?: me)?|(?:let['’]s )?go to) (?:(?:my|the) )?(?:tickets(?: boards?)?|ticket boards?)[.!?]?$/i.test(
			request
		)
	)
		return {
			kind: "tickets" as const,
			tool: "open_command_center",
			args: { section: "tickets" },
			acknowledgement: "You're at your ticket boards.",
		};
	const primary = observed?.workspace.canvases.find((c) => c.id === observed.workspace.primaryId);
	if (primary?.kind !== "browser" || !observed?.browser?.presented) return undefined;
	const viewport =
		/^(?:please )?(?:show|view|switch)(?: (?:me|it|this|that|the|same|page|browser)){0,6} (?:(?:at|in|to) )?(phone|mobile|desktop) (?:size|view|mode)[.!?]?$/i.exec(
			request
		);
	if (!viewport) return undefined;
	const phone = viewport[1]?.toLowerCase() !== "desktop";
	return {
		kind: phone ? ("phone" as const) : ("desktop" as const),
		tool: "browser_action",
		args: {
			action: {
				kind: "viewport",
				viewport: phone ? { width: 390, height: 844 } : { width: 1024, height: 768 },
			},
		},
		acknowledgement: `It's at ${phone ? "phone" : "desktop"} size now.`,
	};
}
