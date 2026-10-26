import type { PRPreparation } from "../../shared/contracts";
import type { Artifact } from "./model";

export function panelCopy(
	preparation: PRPreparation,
	sourceMode: "reference" | "repository",
	panel: Artifact | null,
	conversation: { question: string; answer: string; state: string }
) {
	if (conversation.question)
		return {
			label: "You",
			question: conversation.question,
			answer:
				conversation.answer ||
				(conversation.state === "working" ? "Looking at the code in context…" : "No response yet."),
		};
	if (sourceMode !== "reference" || preparation.evidence.kind !== "fixture")
		return { label: "Review context", question: preparation.pr.title, answer: preparation.summary };
	return {
		label: "Reference prompt",
		question:
			panel === "scenario"
				? "What happens in scenario C? Show me."
				: panel === "preview"
					? "Show me the checkout when the cap applies."
					: "What should I look at here?",
		answer:
			panel === "scenario"
				? "The nightly job hits an expired code. Both versions follow the same path until step 4. Then they split."
				: panel === "preview"
					? "A Platinum shopper, VIP30, and a €120 cart. On a phone, the cap note wraps and Pay moves below the fold."
					: "Start with the discount rule. Follow the change through the order, then check the checkout states. The expired-code path needs a closer look.",
	};
}
