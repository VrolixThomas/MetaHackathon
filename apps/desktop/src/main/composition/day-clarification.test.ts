import assert from "node:assert/strict";
import { test } from "node:test";
import { ConversationDayTools } from "../agent/day-tools";
import type { DayState } from "../day/model";
import { DayService } from "../day/service";
import { harness as slackHarness, source } from "../slack/test-support";
import {
	operatePublicDay,
	publicDayResult,
	publicDaySnapshot,
	readDayClarification,
} from "./day-clarification";

async function setup() {
	const slack = slackHarness();
	const message = await slack.client.sourceMessage(source);
	let state: DayState | null = null;
	const day = new DayService({
		actor: { workspaceId: "T123", userId: "U123" },
		store: {
			loadState: async () => structuredClone(state),
			saveState: async (next) => {
				state = structuredClone(next);
			},
		},
		availability: () => ({ awake: true, online: true }),
		replies: {
			readClarification: async () => ({
				connectionId: "controlled-connection",
				complete: true,
				messages: [message],
			}),
			send: async () => {
				throw new Error("No send expected");
			},
			reconcile: async () => ({ status: "not_found" }),
		},
	});
	await day.capture({
		requestId: "capture-clarification",
		message,
		title: "Request",
		summary: "Actual source",
		kind: "request",
	});
	const initial = (await day.snapshot()).items[0];
	assert.ok(initial);
	await day.operate({
		requestId: "propose-clarification",
		operation: {
			kind: "propose_clarification",
			itemId: initial.id,
			expectedRevision: initial.revision,
			scope: "Ask which version is affected",
			maxMessages: 2,
			durationMinutes: 30,
		},
	});
	const item = (await day.snapshot()).items[0];
	assert.ok(item?.clarification);
	return { day, message, item, input: { itemId: item.id, expectedRevision: item.revision } };
}

test("polling exposes policy metadata without cached thread, question bodies or inferred briefs", async () => {
	const h = await setup();
	try {
		const raw = await h.day.snapshot();
		const visible = publicDaySnapshot(raw);
		assert.equal(visible.items[0]?.clarification, undefined);
		assert.ok(
			!Object.hasOwn(visible.items[0] ?? {}, "clarification"),
			"Omit the optional wire property rather than serializing undefined as null"
		);
		assert.equal(
			visible.items[0]?.clarificationMetadata?.policyId,
			h.item.clarification?.policy.id
		);
		assert.ok(raw.items[0]?.clarification, "Sanitization must not mutate private persisted state");
		assert.ok(!JSON.stringify(visible).includes("originalRequest"));
		assert.ok(!JSON.stringify(visible).includes("evidence"));
	} finally {
		await h.day.dispose();
	}
});

test("fresh proposal receipts never disclose other items' cached thread text", async () => {
	const h = await setup();
	try {
		const snapshot = await h.day.snapshot();
		const other = structuredClone(h.item);
		other.id = "other-item";
		snapshot.items.push(other);
		const result = { requestId: "proposal-result", itemId: h.item.id, snapshot };
		const visible = publicDayResult(result, "propose_clarification", true);
		assert.deepEqual(visible.snapshot.items[0]?.clarification, h.item.clarification);
		assert.equal(visible.snapshot.items[1]?.clarification, undefined);
		assert.equal(
			publicDayResult(result, "confirm_clarification").snapshot.items[0]?.clarification,
			undefined
		);
	} finally {
		await h.day.dispose();
	}
});

test("replayed proposal receipts do not turn stored text into a fresh authorized read", async () => {
	const h = await setup();
	try {
		const replay = await operatePublicDay(() => h.day, {
			requestId: "propose-clarification",
			operation: {
				kind: "propose_clarification",
				itemId: h.item.id,
				expectedRevision: h.item.revision - 1,
				scope: "Ask which version is affected",
				maxMessages: 2,
				durationMinutes: 30,
			},
		});
		assert.equal(replay.snapshot.items[0]?.clarification, undefined);
		const fresh = await operatePublicDay(() => h.day, {
			requestId: "new-proposal",
			operation: {
				kind: "propose_clarification",
				itemId: h.item.id,
				expectedRevision: h.item.revision,
				scope: "Ask which version is affected",
				maxMessages: 2,
				durationMinutes: 30,
			},
		});
		assert.ok(fresh.snapshot.items[0]?.clarification);
	} finally {
		await h.day.dispose();
	}
});

test("an explicit inspection requires fresh access and matching exact source evidence", async () => {
	const h = await setup();
	try {
		let reads = 0;
		const ports = {
			getDay: () => h.day,
			readSource: async () => {
				reads++;
				return [h.message];
			},
		};
		const result = await readDayClarification(ports, h.input, new AbortController().signal);
		assert.deepEqual(result.clarification, h.item.clarification);
		assert.equal(reads, 1);
		await assert.rejects(
			readDayClarification(
				{
					...ports,
					readSource: async () => {
						throw Error("Revoked");
					},
				},
				h.input,
				new AbortController().signal
			),
			/Revoked/
		);
		await assert.rejects(
			readDayClarification(
				{ ...ports, readSource: async () => [{ ...h.message, text: "Edited source" }] },
				h.input,
				new AbortController().signal
			),
			/changed|unavailable/
		);
		await assert.rejects(
			readDayClarification(
				{
					...ports,
					readSource: async () => [
						{
							...h.message,
							citation: {
								...h.message.citation,
								audience: { ...h.message.citation.audience, readerIds: [] },
							},
						},
					],
				},
				h.input,
				new AbortController().signal
			),
			/changed|unavailable/
		);
	} finally {
		await h.day.dispose();
	}
});

test("account retirement and item changes during source reads reject late clarification text", async () => {
	const h = await setup();
	try {
		const retired = { snapshot: () => h.day.snapshot() };
		let active = true;
		await assert.rejects(
			readDayClarification(
				{
					getDay: () => (active ? h.day : retired),
					readSource: async () => {
						active = false;
						return [h.message];
					},
				},
				h.input,
				new AbortController().signal
			),
			/changed/
		);
		await assert.rejects(
			readDayClarification(
				{
					getDay: () => h.day,
					readSource: async () => {
						await h.day.operate({
							requestId: "change-during-read",
							operation: { kind: "accept", ...h.input },
						});
						return [h.message];
					},
				},
				h.input,
				new AbortController().signal
			),
			/changed/
		);
	} finally {
		await h.day.dispose();
	}
});

test("foreground inspection uses the fresh source port and never substitutes cached evidence after denial", async () => {
	const h = await setup();
	try {
		let allowed = true;
		let reads = 0;
		const tools = new ConversationDayTools(
			{
				snapshot: async () => publicDaySnapshot(await h.day.snapshot()),
				operate: async () => {
					throw Error("No operation expected");
				},
				inspectClarification: async (input, signal) => {
					reads++;
					return readDayClarification(
						{
							getDay: () => h.day,
							readSource: async () => {
								if (!allowed) throw Error("Access revoked");
								return [h.message];
							},
						},
						input,
						signal
					);
				},
			},
			{
				sessionId: "source-inspection",
				turnId: "turn",
				requestId: "request",
				generation: 1,
				text: "Inspect this item",
			},
			new AbortController().signal,
			{ identifiers: async () => ({ repositoryIds: [], issueIds: [] }), review: async () => {} }
		);
		const queue = await tools.observe();
		assert.ok(!JSON.stringify(queue).includes("originalRequest"));
		const detail = await tools.execute("day_inspect_item", JSON.stringify({ itemId: h.item.id }));
		assert.ok(JSON.stringify(detail).includes("originalRequest"));
		assert.equal(reads, 1);
		allowed = false;
		await assert.rejects(
			tools.execute("day_inspect_item", JSON.stringify({ itemId: h.item.id })),
			/Access revoked/
		);
		assert.equal(reads, 2);
	} finally {
		await h.day.dispose();
	}
});
