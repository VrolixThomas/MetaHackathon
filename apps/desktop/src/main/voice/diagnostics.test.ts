import assert from "node:assert/strict";
import { test } from "node:test";
import {
	VoiceDiagnosticError,
	VoiceDiagnosticSchema,
	isVoiceDiagnosticMessage,
	voiceDiagnosticMessage,
} from "./diagnostics";

test("diagnostics accept only bounded metadata and generate their own messages", () => {
	const valid = { stage: "elevenlabs", code: "auth", httpStatus: 401 } as const;
	assert.match(new VoiceDiagnosticError(valid).message, /ElevenLabs.*API key/);
	assert.deepEqual(new VoiceDiagnosticError(valid).diagnostic, valid);
	assert.equal(isVoiceDiagnosticMessage(new VoiceDiagnosticError(valid).message), true);
	assert.equal(
		isVoiceDiagnosticMessage(`${new VoiceDiagnosticError(valid).message} secret`),
		false
	);
	assert.equal(isVoiceDiagnosticMessage("secret provider body"), false);
	for (const extra of [
		{ message: "secret-provider-body" },
		{ key: "secret-key" },
		{ sdp: "private" },
	])
		assert.equal(VoiceDiagnosticSchema.safeParse({ ...valid, ...extra }).success, false);
	assert.equal(
		VoiceDiagnosticSchema.safeParse({ ...valid, code: "provider-secret" }).success,
		false
	);
	assert.equal(VoiceDiagnosticSchema.safeParse({ ...valid, httpStatus: 999 }).success, false);
	assert.equal(VoiceDiagnosticSchema.safeParse({ ...valid, closeCode: 5000 }).success, false);
	assert.match(
		voiceDiagnosticMessage({ stage: "meta", code: "rate-limit", closeCode: 1013 }),
		/rate-limited/
	);
});
