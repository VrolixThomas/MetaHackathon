/** App control only for a complete, final utterance. Never a substring/worker command. */
export function isStopSpeech(text: string): boolean {
	return /^(?:(?:please\s+)?stop(?:\s+(?:talking|speaking))?(?:[,\s]+please)?|(?:please\s+)?(?:be quiet|quiet please))[.!?,\s]*$/iu.test(
		text.trim()
	);
}
