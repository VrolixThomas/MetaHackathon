import assert from "node:assert/strict";
import { it } from "node:test";
import { WORKSPACE_GITHUB_REQUIRED } from "../../shared/contracts";
import { createConversationApi } from "./api";

it("preserves only the fixed workspace connection diagnostic across the IPC error boundary", async () => {
	const api = createConversationApi(async () => ({
		error: {
			code: -32001,
			message: WORKSPACE_GITHUB_REQUIRED,
			data: { code: "UNAUTHORIZED", httpStatus: 401 },
		},
	}));
	await assert.rejects(api.call("mutation", "workspace.prepare", {}), {
		message: WORKSPACE_GITHUB_REQUIRED,
	});
	await assert.rejects(
		api.call("mutation", "unrelated.operation", {}),
		(error) => error instanceof Error && error.message !== WORKSPACE_GITHUB_REQUIRED
	);
	const untrusted = createConversationApi(async () => ({
		error: {
			code: -32001,
			message: "upstream private payload",
			data: { code: "UNAUTHORIZED", httpStatus: 401 },
		},
	}));
	await assert.rejects(
		untrusted.call("mutation", "workspace.prepare", {}),
		(error) => error instanceof Error && !error.message.includes("private payload")
	);
});
