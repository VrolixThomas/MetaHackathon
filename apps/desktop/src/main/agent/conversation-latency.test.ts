import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationService } from "./conversation";
import { probeConversationLatency } from "./conversation-latency.probe";
import { workspaceRequestTools } from "./workspace-conversation";

test("actual conversation routes reuse only the initial snapshot and retain later round/receipt waits", async () => {
	const results = await probeConversationLatency(ConversationService, 0);
	assert.deepEqual(
		results.map((row) => [row.modelRounds, row.workspaceReads, row.hubReads, row.dayReads]),
		[
			[1, 1, 1, 1],
			[2, 2, 2, 2],
			[0, 1, 1, 0],
			[1, 2, 2, 1],
			[3, 2, 2, 2],
			[1, 2, 2, 1],
		]
	);
	for (const row of results) {
		// Work profiles now also offer gated pinned-source read/search and source/flow presentation directly.
		assert(row.requests.every((request) => request.toolCount < 29));
		if (row.scenario === "workspace-action") assert.equal(row.requests.length, 0);
		if (["simple", "planning-followup"].includes(row.scenario))
			assert((row.requests[0]?.toolCount ?? 100) < 10);
		assert.equal(row.firstAudioMs, null);
		assert.equal(row.inputTokens, null);
		if (row.scenario === "selected-ticket") {
			assert.equal(row.requests[0]?.toolCount, 0);
			assert((row.firstPublishedMs ?? 0) < (row.requests[0]?.terminalMs ?? 0));
		} else assert((row.firstPublishedMs ?? 0) >= (row.requests[0]?.terminalMs ?? 0));
	}
	assert.equal(results.find((row) => row.scenario === "scoped-dispatch")?.admissions, 1);
	assert.equal(results.find((row) => row.scenario === "selected-ticket")?.ticketReads, 1);
	assert.equal(results.find((row) => row.scenario === "selected-pr")?.sourceReads, 1);
	const action = results[2];
	assert(action && action.receiptWaitMs > 0);
	assert((action.firstPublishedMs ?? 0) >= action.receiptWaitMs);
});

test("request schema compaction preserves every tool, description, ref and validation constraint without mutation", () => {
	const parameters = Object.freeze({
		$schema: "https://json-schema.org/draft/2020-12/schema",
		type: "object",
		properties: { id: { type: "string", minLength: 1 }, nested: { $ref: "#/$defs/value" } },
		required: ["id"],
		additionalProperties: false,
		$defs: { value: { type: "integer", minimum: 1 } },
	});
	const tool = Object.freeze({
		type: "function" as const,
		name: "controlled",
		description: "Require actual user confirmation and current source.",
		parameters,
	});
	const [result] = workspaceRequestTools([tool]);
	assert(result);
	assert.deepEqual(
		{ ...result, parameters: { $schema: parameters.$schema, ...result.parameters } },
		tool
	);
	assert(!Object.hasOwn(result.parameters, "$schema"));
	assert(Object.hasOwn(parameters, "$schema"));
});
