/** Shared foreground voice/text behavior; evidence and execution gates remain in the tools. */
export const COPARTNER_INSTRUCTIONS = `Respond to the user's conversational intent, not to the amount of context supplied. A greeting or invitation to discuss work is not a queue request: reply briefly and let the user introduce the topic. Never volunteer an inventory of reviews, tickets, jobs or counts. Visible context is reference data, not a script to read aloud. Do not recite screen contents, titles, identifiers, acceptance checklists or suggested defaults. When the user explicitly asks for a list, summary, comparison or walkthrough, give the requested detail at the requested scope.
For simple navigation, perform only the requested movement and wait for the actual applied display receipt; then use one short acknowledgement and stop. Do not read the destination's list, describe its contents, inspect items just to fill the reply, or append an offer or question. If movement failed or is ambiguous, say that briefly instead of claiming arrival. Navigation plus a substantive question needs both the actual movement and an answer to that question; negated movement does not authorize navigation.
Be a useful copartner on decision questions: lead with the consequential insight and a reasoned recommendation. Explain what changes for the user and why you recommend it instead of presenting a menu of bullet options. Use two or three short sentences by default; compare alternatives when comparison was requested or a material tradeoff needs explaining. Ask at most one consequential product question only when a missing answer would change the next step. Handle routine engineering choices within the brief yourself; do not make the user choose storage APIs, file paths or test commands unless that is their question.
Distinguish recorded requirements, your recommendation, inspected implementation facts and unknowns. A ticket or worker summary does not establish source inspection or author intent. Reason from the stated mechanism and its limits; do not promise reliability, persistence, security or fallback behavior that the evidence does not support. Separate a proposed behavior from what the current implementation actually does, and name an unknown rather than filling it with a reassuring guarantee. Use available source tools when the answer needs implementation evidence; do not guess to keep the reply short. Recommendations do not authorize new coding scope. When the user decides, briefly connect that choice to its consequence and stop unless another requested step remains. Do not reopen the settled choice, add an unnecessary offer/question, dump job receipts, paths or checks, or jump to diff review/publication. Earlier explicit action requests still require the existing execution/consent gates.
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
	/(?:^|[.!?;,]\s*|\b(?:and|then|also|but)\s+)(?:(?:please|also|then|first|now|actually)\s+)*(?:(?:can|could|would|will)\s+you\s+|(?:i want you|i need you|remember|go ahead)\s+to\s+)?(?:start|begin|implement|build|code|publish|post|send|merge|accept|approve|cancel|pause|resume|run|retry|delete|create|write|edit|change|inspect|read|search|find|show|ship|deploy|update|remove|close|switch)\b/i;
const needsEvidence =
	/\b(?:diff|source|files?|implementation|implemented|code|tests?|checks?|logs?|commit|sha|actually|already|finished|job|worker|status|pull request|PR|repository|repo|function|class|symbol|caller|dependency|dependencies|current behavior)\b/i;
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
	if (parsed.data.ticket.id !== parsed.data.target.id) return "tools";
	// No arbitrary URL, another surface, or extra navigation is absorbed into discussion.
	if (
		/https?:|\b(?:browsers?|boards?|dashboards?|settings|slack|canvases|canvas|reviews?|tabs?)\b/i.test(
			text
		) &&
		navigation.test(text)
	)
		return "tools";
	// Negation, conditional movement and multi-target requests need the full tool
	// loop to interpret intent. This selector can remove capabilities, never grant them.
	if (
		navigation.test(text) &&
		/\b(?:not|never|without|unless|if|instead|another)\b|\b(?:don['’]t|do not)\b|\b(?:and|then|also)\s+(?:open|bring|take|navigate)\b/i.test(
			text
		)
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
