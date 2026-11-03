// Controlled HTTP protocol only: never imports app services/controllers or supplies publication receipts.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { response: foregroundResponse } = require("../comment-conversation-smoke/model.cjs");
const MODEL = "https://api.meta.ai/v1/responses";
const MODEL_KEY = "controlled-standing-model-not-a-key";
const TOKEN = "xoxp-controlled-standing-not-a-token";
const ACTOR = { workspaceId: "T76001", userId: "U76001" };
const REQUESTER = "U76002";
const CHANNEL = "C76001";
const APP_ID = "A76001";
const SCOPE = "reporting period and level of detail";
const POLICY = {
	scope: SCOPE,
	durationMinutes: 5,
	maxThreads: 3,
	messagesPerThread: 1,
	globalMessageBudget: 3,
};
const QUESTION = "Which reporting period and level of detail should the report cover?";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const scopes = [
	"channels:read",
	"channels:history",
	"groups:read",
	"groups:history",
	"im:read",
	"im:history",
	"mpim:read",
	"mpim:history",
	"users:read",
	"chat:write",
];
const canonical = () =>
	`For 5 minutes after you confirm, I can ask clarification questions about “${SCOPE}” in Slack channel ${CHANNEL}, only for new requests that mention you. I can reply in up to 3 original threads, with at most 1 messages per thread and 3 messages total. Older requests are excluded. This does not accept work, start work, or send final answers. You can revoke the rule at any time. Activate this rule?`;
function create({ report, day, standing, fail }) {
	const sources = [];
	const sent = [];
	const holds = new Set();
	let held = null;
	let lastTs = 0;
	function add(label) {
		const n = Math.max(Date.now() * 1000, lastTs + 1);
		lastTs = n;
		const ts = `${Math.floor(n / 1000000)}.${String(n % 1000000).padStart(6, "0")}`;
		const m = {
			ts,
			user: REQUESTER,
			text: `<@${ACTOR.userId}> please prepare the report; ask me which period. Controlled ${label}.`,
			reply_count: 0,
		};
		sources.push(m);
		return m;
	}
	const record = (ts) => day().records.find((r) => r.item.source?.source.messageId === ts);
	function release() {
		held?.release();
		held = null;
	}
	async function fetch(input, init = {}) {
		try {
			const url = new URL(String(input.url ?? input));
			assert.equal(init.method, "POST");
			if (url.href === MODEL) {
				assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${MODEL_KEY}`);
				const body = JSON.parse(init.body);
				assert.equal(body.stream, true);
				assert.equal(body.store, false);
				assert.ok(report.http.length < 1600, "HTTP budget");
				if (
					body.instructions.startsWith("Classify one Slack message") ||
					body.instructions.startsWith("Identify only missing context")
				) {
					assert.deepEqual(body.tools ?? [], []);
					const context = JSON.parse(body.input[0].content[0].text);
					if (body.instructions.startsWith("Classify one Slack message")) {
						const source = sources.find((m) => m.ts === context.message.source.messageId);
						report.http.push({
							kind: "classifier",
							source: context.message.source,
							at: Date.now(),
						});
						return foregroundResponse(body, {
							text: JSON.stringify(
								source
									? {
											title: `Controlled ${source.ts}`,
											summary: "Report needs a reporting period.",
											kind: "request",
											intent: "request_to_actor",
											explicitOwnPromise: false,
											repositoryId: null,
											questions: [],
											priorityReason: "Controlled incoming mention",
											priorityRank: 50,
											sourceQuote: null,
										}
									: null
							),
						});
					}
					const ts = context.policy.source.messageId;
					assert.ok(sources.some((m) => m.ts === ts));
					report.http.push({
						kind: "clarification",
						messageId: ts,
						policy: context.policy,
						at: Date.now(),
					});
					if (holds.has(ts)) {
						assert.equal(held, null);
						await new Promise((resolve, reject) => {
							const finish = () => {
								clearTimeout(timer);
								init.signal?.removeEventListener("abort", abort);
								resolve();
							};
							const abort = () => {
								clearTimeout(timer);
								reject(Error("Controlled request cancelled"));
							};
							const timer = setTimeout(
								() => reject(fail(Error("Model hold exceeded 25 seconds"))),
								25000
							);
							held = { ts, release: finish };
							init.signal?.addEventListener("abort", abort, { once: true });
							if (init.signal?.aborted) abort();
						});
						holds.delete(ts);
					}
					return foregroundResponse(body, {
						text: JSON.stringify({
							summary: "Reporting period is missing.",
							missing: ["Reporting period"],
							questions: [QUESTION],
							escalation: null,
						}),
					});
				}
				const index = body.input.findLastIndex(
					(i) => i.role === "user" && typeof i.content === "string"
				);
				assert.ok(index >= 0);
				const text = body.input[index].content;
				const calls = body.input.slice(index + 1).filter((i) => i.type === "function_call");
				const result = (call) => {
					const r = body.input.find(
						(i) => i.type === "function_call_output" && i.call_id === call.call_id
					);
					assert.ok(r);
					return JSON.parse(r.output);
				};
				let step;
				if (!body.tools.some((t) => t.name === "standing_clarification_list"))
					step = { tool: "expand_tools", args: { families: ["day"] } };
				else if (text.startsWith("Propose a standing clarification rule")) {
					assert.ok(
						!calls.some((c) => c.name === "standing_clarification_propose"),
						"Canonical proposal must terminate without another model call"
					);
					step = { tool: "standing_clarification_propose", args: POLICY };
				} else if (text === "yes") {
					const confirm = calls.find((c) => c.name === "standing_clarification_confirm");
					if (!confirm) step = { tool: "standing_clarification_confirm", args: {} };
					else {
						assert.equal(result(confirm).status, "active");
						step = { text: "The rule is active." };
					}
				} else if (text.startsWith("revoke rule ")) {
					const listed = calls.find((c) => c.name === "standing_clarification_list");
					const revoked = calls.find((c) => c.name === "standing_clarification_revoke");
					if (!listed) step = { tool: "standing_clarification_list", args: {} };
					else if (!revoked) {
						const id = text.slice("revoke rule ".length);
						assert.ok(result(listed).some((r) => r.policy.id === id));
						step = { tool: "standing_clarification_revoke", args: { ruleId: id } };
					} else {
						assert.equal(result(revoked).status, "revoked");
						step = { text: "The rule is revoked." };
					}
				} else throw Error("Unexpected foreground user text");
				report.http.push({ kind: "foreground", text, tool: step.tool ?? null, at: Date.now() });
				return foregroundResponse(body, step);
			}
			assert.equal(url.origin, "https://slack.com");
			assert.equal(url.search, "");
			assert.ok(url.pathname.startsWith("/api/"));
			assert.equal(init.redirect, "error");
			assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${TOKEN}`);
			const method = url.pathname.slice(5);
			const fields =
				method === "chat.postMessage"
					? JSON.parse(init.body)
					: Object.fromEntries(new URLSearchParams(init.body));
			report.http.push({ kind: "slack", method, at: Date.now() });
			const response = (value) =>
				Response.json({ ok: true, ...value }, { headers: { "x-oauth-scopes": scopes.join(",") } });
			if (method === "auth.test")
				return response({
					team_id: ACTOR.workspaceId,
					user_id: ACTOR.userId,
					team: "Controlled workspace",
					user: "controlled-user",
					url: "https://controlled.slack.com/",
				});
			if (method === "users.info")
				return response({
					user: {
						id: fields.user,
						team_id: ACTOR.workspaceId,
						name: "controlled-user",
						is_bot: false,
						deleted: false,
						profile: {
							display_name: "Controlled participant",
							real_name: "Controlled participant",
						},
					},
				});
			const channel = {
				id: CHANNEL,
				name: "controlled-standing",
				is_channel: true,
				is_private: true,
				is_member: true,
			};
			if (method === "users.conversations")
				return response({ channels: [channel], response_metadata: { next_cursor: "" } });
			assert.equal(fields.channel, CHANNEL);
			if (method === "conversations.info") return response({ channel });
			if (method === "conversations.members")
				return response({
					members: [ACTOR.userId, REQUESTER],
					response_metadata: { next_cursor: "" },
				});
			if (method === "chat.postMessage") {
				assert.equal(fields.text, QUESTION);
				assert.equal(report.posts.length, 0, "Only the first approved thread may send");
				const r = record(fields.thread_ts);
				assert.ok(r);
				const c = r.item.clarification;
				const authority = c.policy.standingAuthority;
				assert.ok(authority);
				const parent = standing().rules.find((r) => r.policy.id === authority.ruleId);
				assert.equal(parent.status, "active");
				assert.ok(Date.now() < Date.parse(parent.expiresAt));
				assert.equal(c.confirmedAt, null);
				const attempt = r.outbox.find((o) => o.body === fields.text && o.providerKey);
				assert.equal(attempt.status, "uncertain");
				assert.equal(attempt.superseded, false);
				assert.equal(attempt.bodyDigest, digest(QUESTION));
				const message = {
					ts: `${Math.floor(Date.now() / 1000)}.999999`,
					thread_ts: fields.thread_ts,
					user: ACTOR.userId,
					text: fields.text,
				};
				sent.push(message);
				report.posts.push({
					messageId: message.ts,
					originalThread: fields.thread_ts,
					requestId: attempt.requestId,
					bodyDigest: attempt.bodyDigest,
					standingAuthority: authority,
					reservedBeforeHTTP: true,
				});
				return response({ channel: CHANNEL, ts: message.ts, message });
			}
			assert.ok(
				["conversations.history", "conversations.replies"].includes(method),
				"Unexpected Slack method"
			);
			assert.ok(!fields.cursor);
			let messages =
				method === "conversations.replies"
					? [
							...sources.filter((m) => m.ts === fields.ts),
							...sent.filter((m) => m.thread_ts === fields.ts),
						]
					: [...sources];
			const compare = (a, b) => BigInt(a.replace(".", "")) - BigInt(b.replace(".", ""));
			messages = messages.filter(
				(m) =>
					(!fields.oldest ||
						(fields.inclusive === "true"
							? compare(m.ts, fields.oldest) >= 0
							: compare(m.ts, fields.oldest) > 0)) &&
					(!fields.latest ||
						(fields.inclusive === "true"
							? compare(m.ts, fields.latest) <= 0
							: compare(m.ts, fields.latest) < 0))
			);
			if (method === "conversations.history") messages.reverse();
			return response({
				messages: messages.slice(0, Number(fields.limit)),
				has_more: false,
				response_metadata: { next_cursor: "" },
			});
		} catch (error) {
			if (error.message === "Controlled request cancelled") throw error;
			throw fail(error);
		}
	}
	return {
		fetch,
		add,
		hold: (ts) => holds.add(ts),
		release,
		get held() {
			return held;
		},
		record,
	};
}
module.exports = {
	MODEL,
	MODEL_KEY,
	TOKEN,
	ACTOR,
	CHANNEL,
	APP_ID,
	POLICY,
	QUESTION,
	digest,
	canonical,
	create,
};
