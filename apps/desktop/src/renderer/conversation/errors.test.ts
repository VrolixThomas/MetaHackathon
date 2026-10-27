import assert from "node:assert/strict";
import { it } from "node:test";
import { VoiceDiagnosticError } from "../../main/voice/diagnostics";
import { conversationErrorMessage } from "./errors";

it("preserves canonical provider diagnostics without exposing arbitrary upstream text", () => {
	const error = new VoiceDiagnosticError({ stage: "elevenlabs", code: "auth" });
	assert.equal(conversationErrorMessage(error), error.message);
	assert.equal(conversationErrorMessage(error.message), error.message);
	assert.equal(
		conversationErrorMessage(new Error("private upstream response token=secret")).includes(
			"secret"
		),
		false
	);
});
it("uses authoritative microphone status before claiming permission is denied", () => {
	const error = new VoiceDiagnosticError({ stage: "microphone", code: "denied" });
	assert.notEqual(conversationErrorMessage(error, "granted"), error.message);
	assert.notEqual(conversationErrorMessage(error, "unknown"), error.message);
	assert.equal(conversationErrorMessage(error, "denied"), error.message);
});
