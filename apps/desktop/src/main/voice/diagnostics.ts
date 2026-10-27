import { type VoiceDiagnostic, VoiceDiagnosticSchema } from "../../shared/contracts";
export { VoiceDiagnosticSchema };
export type { VoiceDiagnostic };

export function voiceDiagnosticMessage(raw: VoiceDiagnostic): string {
	const value = VoiceDiagnosticSchema.parse(raw);
	if (value.stage === "microphone") {
		if (value.code === "denied")
			return "Microphone access is blocked for this app. Allow it in system privacy settings, then restart the app.";
		if (value.code === "not-found")
			return "No microphone was found. Connect a microphone and select it in system sound settings.";
		if (value.code === "busy")
			return "The microphone is unavailable or in use. Check the selected input and close other apps using it.";
		if (value.code === "timeout")
			return "Microphone permission timed out. Allow microphone access for this app, then try again.";
		return "The microphone could not start. Check the selected input and microphone permission for this app.";
	}
	const subject = {
		setup: "Local voice service",
		media: "Voice audio connection",
		meta: "Meta speech",
		elevenlabs: "ElevenLabs speech",
	}[value.stage];
	if (value.httpStatus && value.httpStatus >= 300 && value.httpStatus < 400)
		return `${subject} refused a redirect. Check the service configuration.`;
	switch (value.code) {
		case "auth":
			return `${subject} authentication failed. Check the configured API key.`;
		case "access":
			return `${subject} access was rejected. Check model or voice access for this account.`;
		case "rate-limit":
			return `${subject} is rate-limited or out of quota. Check account limits and retry later.`;
		case "not-found":
			return value.stage === "elevenlabs"
				? "The ElevenLabs voice was not found. Check the configured voice ID."
				: `${subject} was not found. Check the local voice installation.`;
		case "network":
			return `${subject} could not connect securely. Check the network and system certificates, then retry.`;
		case "tls":
			return `${subject} could not verify the secure connection. Check system certificates and network settings.`;
		case "timeout":
			return `${subject} timed out. Check the connection and try again.`;
		case "unavailable":
			return `${subject} is temporarily unavailable. Retry later.`;
		case "protocol":
		case "invalid-response":
			return `${subject} returned an invalid or incomplete response. Try again.`;
		case "denied":
			return "Audio output is blocked. Start voice from the microphone button and try again.";
		default:
			return `${subject} failed. Check voice setup and try again.`;
	}
}

const canonicalMessages = new Set(
	VoiceDiagnosticSchema.shape.stage.options.flatMap((stage) => [
		...VoiceDiagnosticSchema.shape.code.options.map((code) =>
			voiceDiagnosticMessage({ stage, code })
		),
		voiceDiagnosticMessage({ stage, code: "failed", httpStatus: 302 }),
	])
);
/** RPC can lose Error subclasses. Accept exact generated copy only, never provider text. */
export function isVoiceDiagnosticMessage(message: unknown): message is string {
	return typeof message === "string" && canonicalMessages.has(message);
}

export class VoiceDiagnosticError extends Error {
	readonly diagnostic: Readonly<VoiceDiagnostic>;
	constructor(diagnostic: VoiceDiagnostic) {
		const parsed = VoiceDiagnosticSchema.parse(diagnostic);
		super(voiceDiagnosticMessage(parsed));
		this.name = "VoiceDiagnosticError";
		this.diagnostic = Object.freeze(parsed);
	}
}
