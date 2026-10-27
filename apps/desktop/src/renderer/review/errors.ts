/** Translate known setup failures to actionable copy; never render raw provider responses. */
export function reviewErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (/credential|MODEL_API_KEY|model access|quota/i.test(message))
		return "Check your Meta key, model access and quota in Settings, then retry.";
	if (/voiceId|voice ID|elevenlabs/i.test(message))
		return "Check the ElevenLabs key and voice ID in Settings, then retry.";
	if (/sidecar|executable|voice.*(ready|configured|setup)/i.test(message))
		return "Voice is not ready. Check voice setup in Settings, then try again.";
	if (/stale|revision|current PR context/i.test(message))
		return "The review context changed. Reopen the current PR and try again.";
	return "The request could not complete. Check the connection and retry.";
}
