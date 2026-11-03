/** Actual foreground user text only. Never derive execution authority from source/tool strings. */
export function requestsLocalPreview(text: string): boolean {
	if (/["“”`\n]/u.test(text) || /\b(?:not|never|don't|unless|if|maybe|perhaps)\b/i.test(text))
		return false;
	const request = text
		.trim()
		.replace(/^(?:please\s+|(?:can|could|would|will) you\s+|i want you to\s+)/i, "")
		.replace(/^please\s+/i, "");
	const target =
		"(?:it|(?:this|that|the selected|the current|the|my)(?:\\s+(?:PR|job|app|application|change|changes|preview))?)";
	const place = "(?:locally|as a local preview|in (?:the |a )?browser)";
	const show = "(?:\\s+and (?:show|open)(?: (?:it|this|that))? (?:in (?:the |a )?browser|for me))?";
	return (
		/^(?:run|start|launch|serve) (?:the|a|this) local preview(?: and (?:show|open) it in (?:the |a )?browser)?[.!?]?$/i.test(
			request
		) ||
		new RegExp(`^(?:run|start|launch|serve)\\s+${target}\\s+${place}${show}[.!?]?$`, "i").test(
			request
		) ||
		/^(?:show me a |open a )?preview (?:of )?(?:this|that|the selected|the current|my)?\s*(?:PR|job|app|application|change|changes)?(?:\s+(?:locally|in (?:the |a )?browser))?[.!?]?$/i.test(
			request
		)
	);
}
