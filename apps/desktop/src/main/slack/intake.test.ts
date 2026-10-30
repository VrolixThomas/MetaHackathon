import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type SlackCheckpoint,
	SlackIntake,
	type SlackIntakeOptions,
	type SlackPublication,
} from "./intake";
import { type Handler, credential, harness, rawMessage, source } from "./test-support";
import { SlackError } from "./types";

function event(eventId: string, inner: unknown) {
	return {
		type: "event_callback",
		team_id: "T123",
		api_app_id: "A123",
		event_id: eventId,
		authorizations: [{ team_id: "T123", user_id: "U123", is_bot: false }],
		event: inner,
	};
}
function message(eventId = "Ev1", extra = {}) {
	return event(eventId, { type: "message", channel: "D123", ...rawMessage, ...extra });
}
function intakeHarness(handler?: Handler, overrides: Partial<SlackIntakeOptions> = {}) {
	let checkpoint: SlackCheckpoint | undefined;
	const batches: SlackPublication[] = [];
	const { client, requests } = harness(handler);
	const options: SlackIntakeOptions = {
		client,
		load: async () => checkpoint,
		save: async (_id, value) => {
			checkpoint = structuredClone(value);
		},
		publish: async (batch) => {
			batches.push(structuredClone(batch));
		},
		now: () => 1_700_000_100_000,
		...overrides,
	};
	return {
		options,
		intake: new SlackIntake(options),
		batches,
		requests,
		checkpoint: () => checkpoint,
	};
}

test("event identity/revision dedup survives reconstruction and ignores older text", async () => {
	const h = intakeHarness();
	assert.equal(await h.intake.receive(message()), "applied");
	assert.equal(await new SlackIntake(h.options).receive(message()), "duplicate");
	assert.equal(h.batches.length, 1);
	const edit = event("Ev2", {
		type: "message",
		subtype: "message_changed",
		channel: "D123",
		event_ts: "1700000002.000001",
		message: { ...rawMessage, text: "edited exact\ntext", edited: { ts: "1700000001.000001" } },
	});
	assert.equal(await h.intake.receive(edit), "applied");
	assert.equal(await h.intake.receive(message("Ev3")), "duplicate");
	assert.equal(h.batches.at(-1)?.messages[0]?.text, "edited exact\ntext");
	assert.equal(h.checkpoint()?.revisions[0]?.revisionId, "1700000001.000001");
});

test("deletion clears text and terminal tombstone fences later history/late events", async () => {
	const h = intakeHarness();
	await h.intake.receive(message());
	await h.intake.receive(
		event("EvDelete", {
			type: "message",
			subtype: "message_deleted",
			channel: "D123",
			event_ts: "1700000003.000001",
			deleted_ts: rawMessage.ts,
			previous_message: rawMessage,
		})
	);
	const deletion = h.batches.at(-1);
	assert.equal(deletion?.messages[0]?.text, "");
	assert.ok(deletion?.messages[0]?.deletedAt);
	assert.equal(deletion?.deletions[0]?.messageId, rawMessage.ts);
	assert.equal(await new SlackIntake(h.options).receive(message("EvLate")), "duplicate");
	const poll = await h.intake.poll({ conversationId: "D123" });
	assert.equal(poll.imported, 0);
	assert.equal(poll.coverage, "bounded-poll-no-delete-proof");
	assert.equal(h.batches.length, 2);
});

test("unknown deletes publish identity-only without invented author or source text", async () => {
	const h = intakeHarness();
	await h.intake.receive(
		event("EvDelete", {
			type: "message",
			subtype: "message_deleted",
			channel: "D123",
			event_ts: "1700000003.000001",
			deleted_ts: rawMessage.ts,
		})
	);
	assert.equal(h.batches[0]?.messages.length, 0);
	assert.equal(h.batches[0]?.deletions[0]?.messageId, rawMessage.ts);
	assert.equal(h.checkpoint()?.revisions[0]?.deleted, true);
});

test("foreign workspace/app/user and bot authorization never enter this user intake", async () => {
	const h = intakeHarness();
	for (const payload of [
		{ ...message(), team_id: "T999" },
		{ ...message(), api_app_id: "A999" },
		{ ...message(), authorizations: [{ team_id: "T123", user_id: "U999", is_bot: false }] },
		{ ...message(), authorizations: [{ team_id: "T123", user_id: "U123", is_bot: true }] },
	])
		assert.equal(await h.intake.receive(payload), "ignored");
	assert.equal(h.requests.length, 0);
	assert.equal(h.batches.length, 0);
});

test("cursor recovery resumes even after an empty page, using a frozen time window", async () => {
	const h = intakeHarness((method, fields) =>
		method === "conversations.history"
			? {
					ok: true,
					messages: fields["cursor"] ? [rawMessage] : [],
					response_metadata: { next_cursor: fields["cursor"] ? "" : "page-two" },
				}
			: undefined
	);
	const first = await h.intake.poll({ conversationId: "D123" });
	assert.equal(first.nextCursor, "page-two");
	const second = await new SlackIntake({ ...h.options, now: () => 1_700_000_200_000 }).poll({
		conversationId: "D123",
	});
	assert.equal(second.imported, 1);
	const reads = h.requests.filter((row) => row.method === "conversations.history");
	assert.equal(reads[1]?.fields["cursor"], "page-two");
	assert.equal(reads[0]?.fields["latest"], reads[1]?.fields["latest"]);
	assert.equal(h.checkpoint()?.polls[0]?.active, false);
});

test("time pagination follows history backwards and threads forwards without claiming full coverage", async () => {
	const h = intakeHarness((method, fields) =>
		method === "conversations.history"
			? { ok: true, messages: [rawMessage], has_more: fields["latest"] !== rawMessage.ts }
			: method === "conversations.replies"
				? {
						ok: true,
						messages: [{ ...rawMessage, ts: "1700000001.000001", thread_ts: source.messageId }],
						has_more: true,
					}
				: undefined
	);
	await h.intake.poll({ conversationId: "D123" });
	await h.intake.poll({ conversationId: "D123" });
	const reads = h.requests.filter((row) => row.method === "conversations.history");
	assert.equal(reads[1]?.fields["latest"], rawMessage.ts);
	assert.equal(reads[1]?.fields["inclusive"], false);
	await h.intake.poll({ conversationId: "D123", threadTs: source.messageId });
	assert.equal(h.checkpoint()?.polls.find((row) => row.threadTs)?.oldest, "1700000001.000001");
});

test("failed durable publication cannot advance event dedup or polling cursor", async () => {
	let fail = true;
	const h = intakeHarness(undefined, {
		publish: async () => {
			if (fail) throw new SlackError("provider");
		},
	});
	await assert.rejects(h.intake.receive(message()), SlackError);
	assert.equal(h.checkpoint(), undefined);
	fail = false;
	assert.equal(await h.intake.receive(message()), "applied");
});

test("checkpoint identity mismatch and invalid oversized events are rejected", async () => {
	const h = intakeHarness();
	await h.intake.receive(message());
	const checkpoint = h.checkpoint();
	assert.ok(checkpoint);
	await assert.rejects(
		new SlackIntake({
			...h.options,
			load: async () => ({ ...checkpoint, userId: "U999" }),
		}).receive(message("Ev2")),
		SlackError
	);
	await assert.rejects(h.intake.receive({ ignored: "x".repeat(2 * 1024 * 1024) }), SlackError);
	assert.equal(credential.connectionId, checkpoint.connectionId);
});
