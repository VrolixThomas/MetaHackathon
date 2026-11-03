import assert from "node:assert/strict";
import { it } from "node:test";
import { conversationErrorDiagnostic } from "./conversation-error-diagnostic";

it("logs only fixed error and frame categories, never source, keys, messages or locations", () => {
	const error = new Error("secret source token at runWorkspaceConversation (private)");
	error.name = "private-account-name";
	error.stack =
		"secret source\n    at async runWorkspaceConversation (/private/secret.ts:123:45)\n    at privateFunction (/private/token:1:2)";
	assert.deepEqual(conversationErrorDiagnostic(error), {
		stage: "conversation-error",
		errorClass: "unknown",
		frame: "runWorkspaceConversation",
	});
	assert.deepEqual(conversationErrorDiagnostic("private token"), {
		stage: "conversation-error",
		errorClass: "unknown",
		frame: "unknown",
	});
	assert.deepEqual(conversationErrorDiagnostic(new TypeError("private source")), {
		stage: "conversation-error",
		errorClass: "TypeError",
		frame: "unknown",
	});
});

it("distinguishes fixed source failures without logging provider messages", () => {
	class HubFailure extends Error {
		constructor(readonly kind: string) {
			super("private provider detail");
		}
	}
	assert.equal(conversationErrorDiagnostic(new HubFailure("notFound")).sourceFailure, "notFound");
	assert.equal(
		conversationErrorDiagnostic(new HubFailure("private-source-data")).sourceFailure,
		undefined
	);
});
