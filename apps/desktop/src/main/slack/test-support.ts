import assert from "node:assert/strict";
import type { ChatReplyReceipt } from "../../shared/contracts/chat";
import { SlackClient, type SlackReplyLedger } from "./client";
import { SLACK_USER_SCOPES } from "./oauth";
import { type SlackCredential, SlackError } from "./types";

export const credential: SlackCredential = {
	connectionId: "controlled-connection",
	workspaceId: "T123",
	userId: "U123",
	appId: "A123",
	tokenKind: "user",
	accessToken: "user-secret",
	scopes: [...SLACK_USER_SCOPES],
};
export const source = {
	provider: "slack" as const,
	workspaceId: "T123",
	conversationId: "D123",
	messageId: "1700000000.000001",
	threadId: null,
	revisionId: "1700000000.000001",
	permalink: null,
};
export const rawMessage = {
	user: "U456",
	text: "exact source <@U123>\nsecond line",
	ts: source.messageId,
};
export function privateChannel(id = "D123") {
	return { id, is_im: true, is_private: true, user: "U456" };
}
export type Handler = (
	method: string,
	fields: Record<string, unknown>
) => unknown | Promise<unknown>;
/** Tests only; product composition must inject a durable atomic ledger. */
export class TestReplyLedger implements SlackReplyLedger {
	readonly rows = new Map<string, { binding: string; receipt?: ChatReplyReceipt }>();
	async reserve(key: string, binding: string) {
		const previous = this.rows.get(key);
		if (previous && previous.binding !== binding) throw new SlackError("request-conflict");
		if (previous?.receipt) return { state: "delivered" as const, receipt: previous.receipt };
		if (previous) return { state: "uncertain" as const };
		this.rows.set(key, { binding });
		return { state: "reserved" as const };
	}
	async delivered(key: string, binding: string, receipt: ChatReplyReceipt) {
		assert.equal(this.rows.get(key)?.binding, binding);
		this.rows.set(key, { binding, receipt });
	}
}
export function harness(
	handler?: Handler,
	getCredential = async (): Promise<SlackCredential | undefined> => credential,
	ledger: SlackReplyLedger = new TestReplyLedger()
) {
	const requests: { method: string; fields: Record<string, unknown> }[] = [];
	const client = new SlackClient({
		getCredential,
		replyLedger: ledger,
		historyIntervalMs: 0,
		now: () => 1_800_000_000_000,
		fetch: (async (input, init) => {
			const url = new URL(String(input));
			assert.equal(url.origin, "https://slack.com");
			assert.equal(init?.redirect, "error");
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer user-secret");
			const method = url.pathname.replace("/api/", "");
			const fields = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ method, fields });
			const result = await handler?.(method, fields);
			if (result instanceof Response) return result;
			if (result) return Response.json(result);
			if (method === "auth.test")
				return Response.json({ ok: true, team_id: "T123", user_id: "U123" });
			if (method === "conversations.info")
				return Response.json({ ok: true, channel: privateChannel(String(fields["channel"])) });
			if (method === "conversations.members")
				return Response.json({ ok: true, members: ["U123", "U456"] });
			if (method === "conversations.history")
				return Response.json({ ok: true, messages: [rawMessage] });
			if (method === "conversations.replies")
				return Response.json({ ok: true, messages: [{ ...rawMessage, thread_ts: fields["ts"] }] });
			if (method === "chat.postMessage")
				return Response.json({
					ok: true,
					channel: fields["channel"],
					ts: "1800000000.000001",
					message: { text: fields["text"], user: "U123", thread_ts: fields["thread_ts"] },
				});
			throw new Error(`Unexpected controlled Slack method ${method}`);
		}) as typeof fetch,
	});
	return { client, requests, ledger };
}
