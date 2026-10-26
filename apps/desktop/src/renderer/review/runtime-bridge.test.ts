import assert from "node:assert/strict";
import { it } from "node:test";
import superjson from "superjson";
import { createRuntimeBridge } from "./runtime-bridge";

it("rejects secret-bearing credential status and never exposes a saved-key getter", async () => {
	const bridge = createRuntimeBridge(async () => ({
		result: {
			data: superjson.serialize([
				{
					provider: "meta",
					configured: true,
					storage: "os-encrypted",
					secret: "must-never-reach-state",
				},
			]),
		},
	}));
	await assert.rejects(() => bridge.settings.status());
	assert.deepEqual(Object.keys(bridge.settings).sort(), [
		"remove",
		"set",
		"signInGitHub",
		"status",
	]);
});
it("uses one direct mutation for transient credential input and validates before IPC", async () => {
	const calls: Array<{ path: string; input: unknown }> = [];
	const bridge = createRuntimeBridge(async (request) => {
		calls.push({ path: request.path, input: superjson.deserialize(request.input) });
		return { result: { data: superjson.serialize(undefined) } };
	});
	await bridge.settings.set("meta", " synthetic-test-key ");
	assert.deepEqual(calls, [
		{ path: "runtime.setCredential", input: { provider: "meta", secret: "synthetic-test-key" } },
	]);
	await assert.rejects(() => bridge.settings.set("meta", " "));
	assert.equal(calls.length, 1);
});
