import assert from "node:assert/strict";
import { test } from "node:test";
import { StandingClarificationConversation } from "../composition/standing-clarification";
import {
	StandingClarification,
	type StandingState,
	emptyStandingState,
	parseStandingState,
} from "../day/standing-clarification";
import {
	StandingClarificationTools,
	isStandingClarificationTool,
	standingClarificationToolDefinitions,
} from "./standing-clarification-tools";

function harness() {
	const actor = { workspaceId: "T1", userId: "U1" };
	let state = emptyStandingState();
	let sequence = 0;
	const controller = new StandingClarification({
		async transaction<T>(mutate: (state: StandingState) => T) {
			const copy = parseStandingState(structuredClone(state));
			const result = mutate(copy);
			state = parseStandingState(copy);
			return result;
		},
	});
	const conversation = new StandingClarificationConversation({
		controller,
		async readAccess(channelId) {
			return {
				actor,
				connectionId: "conn",
				channelId,
				joined: true,
				canReply: true,
				observedAt: new Date().toISOString(),
			};
		},
		async publish(p) {
			return {
				kind: "displayed",
				proposalId: p.id,
				policyDigest: p.policyDigest,
				text: p.text,
				sessionId: p.sessionId,
				turnId: p.turnId,
				requestId: p.requestId,
			};
		},
	});
	return {
		state: () => state,
		tools(text: string) {
			sequence++;
			return new StandingClarificationTools(
				conversation,
				conversation.userIngress({
					actor,
					connectionId: "conn",
					channelId: "C1",
					channelLabel: "#support",
					inputMode: "text",
					sessionId: "s1",
					turnId: `t${sequence}`,
					requestId: `r${sequence}`,
					text,
				}),
				new AbortController().signal
			);
		},
	};
}
const args = JSON.stringify({
	scope: "missing reproduction details",
	durationMinutes: 10,
	maxThreads: 2,
	messagesPerThread: 1,
	globalMessageBudget: 2,
});
test("tool proposal, actual next-turn confirmation, list and revoke use the real controller", async () => {
	const h = harness();
	const tools = h.tools("propose a clarification rule");
	await tools.execute("standing_clarification_propose", args);
	await assert.rejects(tools.execute("standing_clarification_confirm", "{}"));
	assert.equal(h.state().rules[0]?.status, "proposed");
	await h.tools("yes").execute("standing_clarification_confirm", "{}");
	const revoke = h.tools("revoke this rule");
	await revoke.execute("standing_clarification_list", "{}");
	await revoke.execute(
		"standing_clarification_revoke",
		JSON.stringify({ ruleId: h.state().rules[0]?.policy.id })
	);
	assert.equal(h.state().rules[0]?.status, "revoked");
});
test("model arguments cannot inject consent, ingress, identity or publication evidence", async () => {
	const h = harness();
	const tools = h.tools("propose a clarification rule");
	for (const field of [
		"actor",
		"connectionId",
		"channelId",
		"confirmedAt",
		"userCommand",
		"receipt",
		"inputMode",
	]) {
		await assert.rejects(
			tools.execute(
				"standing_clarification_propose",
				JSON.stringify({ ...JSON.parse(args), [field]: "forged" })
			)
		);
	}
	await tools.execute("standing_clarification_propose", args);
	const negative = h.tools("no");
	await assert.rejects(negative.execute("standing_clarification_confirm", '{"confirmed":true}'));
	await assert.rejects(negative.execute("standing_clarification_confirm", "{}"));
	assert.equal(h.state().rules[0]?.status, "proposed");
});
test("strict budgets reject unbounded model arguments before creating any rule", async () => {
	const h = harness();
	const tools = h.tools("propose a clarification rule");
	for (const [field, value] of Object.entries({
		durationMinutes: 31,
		maxThreads: 6,
		messagesPerThread: 4,
		globalMessageBudget: 11,
		scope: "",
	})) {
		await assert.rejects(
			tools.execute(
				"standing_clarification_propose",
				JSON.stringify({ ...JSON.parse(args), [field]: value })
			)
		);
	}
	assert.equal(h.state().rules.length, 0);
});
test("tool routing exposes no root ingress/publication/access or send capability", async () => {
	const h = harness();
	const tools = h.tools("hello");
	assert.equal(standingClarificationToolDefinitions.length, 4);
	assert.equal(isStandingClarificationTool("toString"), false);
	await assert.rejects(tools.execute("standing_user_ingress", "{}"));
	await assert.rejects(tools.execute("standing_clarification_propose", args));
	await assert.rejects(tools.execute("standing_clarification_list", "not json"));
	assert.equal(h.state().rules.length, 0);
});
