import assert from "node:assert/strict";
import { test } from "node:test";
import type { DayState } from "../day/model";
import { DayService } from "../day/service";
import { harness as slackHarness, source } from "../slack/test-support";
import { readDaySource } from "./day-source";

async function setup() {
	const slack = slackHarness();
	let state: DayState | null = null;
	const day = new DayService({
		actor: { workspaceId: "T123", userId: "U123" },
		store: {
			loadState: async () => structuredClone(state),
			saveState: async (next, expected) => {
				assert.equal(state?.sequence ?? 0, expected);
				state = structuredClone(next);
			},
		},
		availability: () => ({ awake: true, online: true }),
	});
	await day.capture({
		requestId: "controlled-source-capture",
		message: await slack.client.sourceMessage(source),
		title: "Controlled request",
		summary: "Source-backed test input",
		kind: "request",
		repositoryId: null,
	});
	const item = (await day.snapshot()).items[0];
	assert.ok(item);
	const input = { itemId: item.id, expectedRevision: item.revision };
	return { slack, day, input };
}

test("Day source reads the exact original thread through current provider authorization", async () => {
	const h = await setup();
	try {
		const result = await readDaySource(
			{ getDay: () => h.day, client: h.slack.client },
			h.input,
			new AbortController().signal
		);
		assert.equal(result[0]?.citation.source.messageId, source.messageId);
		assert.ok(
			h.slack.requests.some(
				(row) => row.method === "conversations.replies" && row.fields["ts"] === source.messageId
			)
		);
		await assert.rejects(
			readDaySource(
				{ getDay: () => h.day, client: h.slack.client },
				{ ...h.input, expectedRevision: 99 },
				new AbortController().signal
			)
		);
	} finally {
		await h.day.dispose();
	}
});

test("a source response cannot escape after the active Day account or item changes", async () => {
	const h = await setup();
	try {
		let active = true;
		const client = {
			sourceMessage: h.slack.client.sourceMessage.bind(h.slack.client),
			thread: async (...args: Parameters<typeof h.slack.client.thread>) => {
				const page = await h.slack.client.thread(...args);
				active = false;
				return page;
			},
		};
		const retired = { snapshot: () => h.day.snapshot() };
		await assert.rejects(
			readDaySource(
				{ getDay: () => (active ? h.day : retired), client },
				h.input,
				new AbortController().signal
			)
		);
		active = true;
		client.thread = async (...args) => {
			const page = await h.slack.client.thread(...args);
			await h.day.operate({
				requestId: "accept-during-source-read",
				operation: { kind: "accept", ...h.input },
			});
			return page;
		};
		await assert.rejects(
			readDaySource({ getDay: () => h.day, client }, h.input, new AbortController().signal)
		);
	} finally {
		await h.day.dispose();
	}
});
