/** Reasoning selection from actual ingress only. This never grants tool or consent authority. */
export function conditionalPRProposalRequested(text: string): boolean {
	// A compound Home request can reach the review after its quick navigation round.
	const request = text
		.trim()
		.replace(
			/^(?:for|on)\s+(?:this\s+|the\s+)?(?:reviewed\s+)?(?:head\s+of\s+)?(?:PR|pull request)\s*#?\d+\s*,\s*/i,
			""
		)
		.replace(
			/^(?:(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?)open\b[^.!?\n;]{0,200}(?:[.!?;]\s*|\s+and\s+)(?=(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:set|configure|draft|edit|update|change|prepare|create|approve|notify|watch|monitor)\b)/i,
			""
		);
	return (
		/^(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:set(?:\s+up)?|configure|draft|edit|update|change|prepare|create|approve|notify|watch|monitor)\b/i.test(
			request
		) &&
		/\b(?:follow[- ]?up|delegation|policy|notify|notification|approve|approval|watch|monitor)\b/i.test(
			request
		) &&
		/\b(?:if|when|once|only|after|until|conditions?|checks?|succeeds?|passes?|expir\w*|within|hours?|minutes?)\b/i.test(
			request
		)
	);
}
