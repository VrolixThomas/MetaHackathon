import { isVoiceDiagnosticMessage, voiceDiagnosticMessage } from "../../main/voice/diagnostics";

const allowed = new Set([
	"Could not load the selected pull request. Check GitHub access or continue without a PR.",
	"Check your Meta API key and model access in the app configuration, then try again.",
	"Meta is limiting requests. Wait a moment and check your quota before trying again.",
	"Meta is temporarily unavailable. Try again shortly.",
	"The model response timed out. Please try again.",
	"Could not reach the model. Check your connection and try again.",
	"The conversation could not complete this reply. Please try again.",
	"The model reached its reply limit. Please ask to continue.",
	"The model reply stopped before it finished. Please try again.",
]);
const denied = voiceDiagnosticMessage({ stage: "microphone", code: "denied" });
/** Preserve fixed local diagnostics; never display raw provider text or infer macOS permission. */
export function conversationErrorMessage(error: unknown, microphone?: string): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (message === denied && microphone !== "denied" && microphone !== "restricted")
		return voiceDiagnosticMessage({ stage: "microphone", code: "failed" });
	return allowed.has(message) || isVoiceDiagnosticMessage(message)
		? message
		: "Could not complete the request. Check configuration and try again.";
}
