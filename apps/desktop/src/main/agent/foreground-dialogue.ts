/** Shared foreground voice/text behavior; evidence and execution gates remain in the tools. */
export const COPARTNER_INSTRUCTIONS = `Be a useful copartner: lead with the consequential insight and a short recommendation with its reason. Explain a relevant consequence or unknown instead of reading the title, acceptance checklist or visible suggested default aloud. For planning, normally use two or three short sentences, then at most one consequential product question. Handle routine engineering choices within the brief yourself; do not make the user choose storage APIs, file paths or test commands unless that is their question.
Distinguish recorded requirements, your recommendation, inspected implementation facts and unknowns. A ticket or worker summary does not establish source inspection or author intent. Recommendations do not authorize new coding scope. When the user chooses, briefly connect that choice to the consequence and continue the discussion; do not dump job receipts, paths or checks or jump to diff review/publication.
Existing ready work is context, not acceptance, publication authority or proof of a current-session action. Mention it only when relevant and explicitly as existing work unless the session effect timeline proves otherwise. Preserve the user's discussion even when such work exists. Continue resumes the actual last topic, including an interrupted question; do not fabricate an answer or a fresh start. A correction is not evidence that you committed an action or caused the problem.`;

import { z } from "zod";
import type { MetaItem } from "./meta-client";

const ticketContext = z.object({
	ticket: z.object({ id: z.string(), description: z.string() }),
	target: z.object({ id: z.string(), displayed: z.boolean() }),
});
const discussion =
	/\b(?:explain|talk me through|discuss|tradeoffs?|trade-offs?|design decisions?|recommend|why|what (?:does|should|design|choice)|how (?:should|would))\b/i;
// Conservative capability selection, not permission/consent classification. Unknown
// requests keep the ordinary tool loop. Explicit operations always keep their gates.
const operation =
	/(?:^|[.!?;]\s*|\band\s+|\bthen\s+)(?:please\s+)?(?:start|begin|implement|build|code|publish|post|send|merge|accept|approve|cancel|pause|resume|run|retry|delete|create|write|edit|change|inspect|read|search|find|show)\b/i;
const needsEvidence =
	/\b(?:diff|source|files?|implementation|implemented|code|tests?|checks?|logs?|commit|sha|actually|already|finished|job|worker|status|pull request|PR)\b/i;
const deep = /\b(?:deep(?:er|ly)?|thorough(?:ly)?|rigorous|architecture)\b/i;
const choiceStart =
	/^(?:yes\b|no\b|make it\b|keep it\b|use |across |only |both\b|neither\b|on this |for now|let['’]s |i (?:want|prefer|choose)|continue\b)/i;
const navigation = /\b(?:open|bring me|take me|navigate)\b/i;

export function ticketDialogueMode(
	text: string,
	history: MetaItem[],
	context: unknown
): "tools" | "navigate-discussion" | "answer" {
	const parsed = ticketContext.safeParse(context);
	if (!parsed.success || operation.test(text) || needsEvidence.test(text) || deep.test(text))
		return "tools";
	// No arbitrary URL, another surface, or extra navigation is absorbed into discussion.
	if (
		/https?:|\b(?:browser|board|dashboard|settings|slack|canvas)\b/i.test(text) &&
		navigation.test(text)
	)
		return "tools";
	const priorUsers = history.filter(
		(item) => item["role"] === "user" && typeof item["content"] === "string"
	);
	const priorReply = history.filter((item) => item["role"] === "assistant").at(-1)?.["content"];
	let discussionThread = false;
	for (const item of priorUsers.slice(0, -1).slice(-4).reverse()) {
		const prior = String(item["content"]);
		if (operation.test(prior) || needsEvidence.test(prior) || deep.test(prior)) break;
		if (discussion.test(prior)) {
			discussionThread = true;
			break;
		}
		if (!choiceStart.test(prior.trim())) break;
	}
	const followup =
		discussionThread &&
		typeof priorReply === "string" &&
		(priorReply.includes("?") || /^continue[?.!\s]*$/i.test(text));
	const choice =
		followup && text.length <= 300 && !navigation.test(text) && choiceStart.test(text.trim());
	if (!discussion.test(text) && !choice) return "tools";
	return navigation.test(text) && !parsed.data.target.displayed ? "navigate-discussion" : "answer";
}
