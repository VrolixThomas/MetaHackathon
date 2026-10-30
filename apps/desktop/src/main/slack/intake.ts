import { z } from "zod";
import { type ChatMessage, ChatMessageSchema, type ChatSource } from "../../shared/contracts/chat";
import { RawSlackMessageSchema, type SlackClient, slackDate, slackMessage } from "./client";
import {
	type SlackCredential,
	SlackError,
	SlackIdSchema,
	SlackTsSchema,
	abortable,
	compareTs,
	parsed,
} from "./types";

const RevisionSchema = z.strictObject({
	key: z.string().min(1).max(300),
	revisionId: SlackTsSchema,
	deleted: z.boolean(),
	authorId: SlackIdSchema.optional(),
	threadId: SlackTsSchema.nullable(),
});
const PollSchema = z.strictObject({
	key: z.string().min(1).max(300),
	conversationId: SlackIdSchema,
	threadTs: SlackTsSchema.nullable(),
	oldest: SlackTsSchema,
	latest: SlackTsSchema,
	through: SlackTsSchema,
	cursor: z.string().max(2000).nullable(),
	active: z.boolean(),
});
export const SlackCheckpointSchema = z
	.strictObject({
		version: z.literal(1),
		connectionId: z.string().min(1).max(200),
		workspaceId: SlackIdSchema,
		userId: SlackIdSchema,
		eventIds: z.array(z.string().min(1).max(200)).max(2048),
		revisions: z.array(RevisionSchema).max(10000),
		polls: z.array(PollSchema).max(128),
	})
	.refine(
		(value) =>
			new Set(value.revisions.map((row) => row.key)).size === value.revisions.length &&
			new Set(value.polls.map((row) => row.key)).size === value.polls.length,
		"Unique checkpoint keys required"
	);
export type SlackCheckpoint = z.infer<typeof SlackCheckpointSchema>;
export interface SlackPublication {
	connectionId: string;
	messages: ChatMessage[];
	/** Unknown-message deletions carry source identity only; never invent an author or retain text. */
	deletions: ChatSource[];
}
export interface SlackIntakeOptions {
	client: SlackClient;
	load(connectionId: string): Promise<unknown | undefined>;
	save(connectionId: string, checkpoint: SlackCheckpoint): Promise<void>;
	/** Idempotent durable source upserts/deletes, fenced by connectionId. Completes before cursor save/ACK. */
	publish(batch: SlackPublication, signal: AbortSignal): Promise<void>;
	now?: () => number;
}
const EventEnvelopeSchema = z.object({
	type: z.literal("event_callback"),
	team_id: SlackIdSchema,
	api_app_id: SlackIdSchema,
	event_id: z.string().min(1).max(200),
	event: z.unknown(),
	authorizations: z
		.array(
			z.object({
				team_id: SlackIdSchema.nullable().optional(),
				user_id: SlackIdSchema.nullable().optional(),
				is_bot: z.boolean(),
			})
		)
		.max(100)
		.optional(),
});
const EventSchema = z.object({
	type: z.literal("message"),
	channel: SlackIdSchema,
	event_ts: SlackTsSchema.optional(),
	ts: SlackTsSchema.optional(),
	subtype: z.string().max(100).optional(),
	message: RawSlackMessageSchema.optional(),
	previous_message: RawSlackMessageSchema.optional(),
	deleted_ts: SlackTsSchema.optional(),
});
function clockTs(now: number): string {
	return `${Math.floor(now / 1000)}.${String(Math.floor(now % 1000) * 1000).padStart(6, "0")}`;
}
function keyOf(source: ChatSource): string {
	return `${source.conversationId}:${source.messageId}`;
}

/** One owner, bounded durable source revision/event-ID dedup and one-page polling checkpoints. */
export class SlackIntake {
	private tail: Promise<unknown> = Promise.resolve();
	private waiting = 0;
	private readonly now: () => number;
	constructor(private readonly options: SlackIntakeOptions) {
		this.now = options.now ?? Date.now;
	}
	private serial<T>(
		signal: AbortSignal | undefined,
		work: (signal: AbortSignal) => Promise<T>
	): Promise<T> {
		if (this.waiting >= 64) return Promise.reject(new SlackError("capacity"));
		this.waiting++;
		const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
		const result = this.tail.then(() => {
			if (bounded.aborted) throw new SlackError("cancelled");
			return work(bounded);
		});
		this.tail = result
			.catch(() => {})
			.finally(() => {
				this.waiting--;
			});
		return abortable(result, bounded);
	}
	private async checkpoint(
		credential: SlackCredential,
		signal: AbortSignal
	): Promise<SlackCheckpoint> {
		let loaded: unknown;
		try {
			loaded = await abortable(this.options.load(credential.connectionId), signal);
		} catch (error) {
			throw error instanceof SlackError ? error : new SlackError("provider");
		}
		const value =
			loaded === undefined
				? {
						version: 1,
						connectionId: credential.connectionId,
						workspaceId: credential.workspaceId,
						userId: credential.userId,
						eventIds: [],
						revisions: [],
						polls: [],
					}
				: loaded;
		const checkpoint = parsed(SlackCheckpointSchema, value);
		if (
			checkpoint.connectionId !== credential.connectionId ||
			checkpoint.workspaceId !== credential.workspaceId ||
			checkpoint.userId !== credential.userId
		)
			throw new SlackError("stale-connection");
		return checkpoint;
	}
	private accept(checkpoint: SlackCheckpoint, message: ChatMessage): boolean {
		const source = message.citation.source;
		const key = keyOf(source);
		const previous = checkpoint.revisions.find((row) => row.key === key);
		if (
			previous &&
			(previous.deleted ||
				(!message.deletedAt && compareTs(source.revisionId, previous.revisionId) <= 0))
		)
			return false;
		const record = {
			key,
			revisionId: source.revisionId,
			deleted: !!message.deletedAt,
			authorId: message.authorId,
			threadId: source.threadId,
		};
		if (previous) Object.assign(previous, record);
		else {
			if (checkpoint.revisions.length >= 10000) throw new SlackError("capacity");
			checkpoint.revisions.push(record);
		}
		return true;
	}
	private async commit(
		credential: SlackCredential,
		checkpoint: SlackCheckpoint,
		batch: SlackPublication,
		signal: AbortSignal
	): Promise<void> {
		parsed(SlackCheckpointSchema, checkpoint);
		await abortable(this.options.client.assertCurrent(credential), signal);
		if (batch.messages.length || batch.deletions.length)
			await abortable(this.options.publish(batch, signal), signal);
		await abortable(this.options.client.assertCurrent(credential), signal);
		try {
			await abortable(this.options.save(credential.connectionId, checkpoint), signal);
		} catch (error) {
			throw error instanceof SlackError ? error : new SlackError("provider");
		}
		await abortable(this.options.client.assertCurrent(credential), signal);
	}
	receive(payload: unknown, signal?: AbortSignal): Promise<"applied" | "duplicate" | "ignored"> {
		return this.serial(signal, async (bounded) => {
			let bytes: number;
			try {
				bytes = Buffer.byteLength(JSON.stringify(payload));
			} catch {
				throw new SlackError("invalid-data");
			}
			if (bytes > 2 * 1024 * 1024) throw new SlackError("invalid-data");
			const parsedEnvelope = EventEnvelopeSchema.safeParse(payload);
			if (!parsedEnvelope.success) return "ignored";
			const envelope = parsedEnvelope.data;
			const credential = await abortable(this.options.client.credential(), bounded);
			if (envelope.team_id !== credential.workspaceId || envelope.api_app_id !== credential.appId)
				return "ignored";
			// A truncated multi-install authorization array is not proof for another user. Fail closed.
			if (
				!envelope.authorizations?.some(
					(row) =>
						row.team_id === credential.workspaceId &&
						row.user_id === credential.userId &&
						!row.is_bot
				)
			)
				return "ignored";
			const checkpoint = await this.checkpoint(credential, bounded);
			if (checkpoint.eventIds.includes(envelope.event_id)) return "duplicate";
			const parsedEvent = EventSchema.safeParse(envelope.event);
			if (!parsedEvent.success) return "ignored";
			const event = parsedEvent.data;
			const audience = await this.options.client.audience(event.channel, bounded, credential);
			const batch: SlackPublication = {
				connectionId: credential.connectionId,
				messages: [],
				deletions: [],
			};
			if (event.subtype === "message_deleted") {
				if (!event.deleted_ts || !event.event_ts) throw new SlackError("invalid-data");
				const key = `${event.channel}:${event.deleted_ts}`;
				const previous = checkpoint.revisions.find((row) => row.key === key);
				if (!previous?.deleted) {
					const raw = event.previous_message;
					if (raw && raw.ts !== event.deleted_ts) throw new SlackError("invalid-data");
					const source: ChatSource = {
						provider: "slack",
						workspaceId: credential.workspaceId,
						conversationId: event.channel,
						messageId: event.deleted_ts,
						threadId: raw?.thread_ts ?? previous?.threadId ?? null,
						revisionId: event.event_ts,
						permalink: null,
					};
					const authorId = raw?.user ?? raw?.bot_id ?? previous?.authorId;
					if (authorId) {
						const message = parsed(ChatMessageSchema, {
							citation: { source, audience },
							authorId,
							text: "",
							createdAt: slackDate(event.deleted_ts),
							updatedAt: slackDate(event.event_ts),
							deletedAt: slackDate(event.event_ts),
							truncated: false,
						});
						if (this.accept(checkpoint, message)) batch.messages.push(message);
					} else {
						if (checkpoint.revisions.length >= 10000) throw new SlackError("capacity");
						checkpoint.revisions.push({
							key,
							revisionId: event.event_ts,
							deleted: true,
							threadId: source.threadId,
						});
					}
					batch.deletions.push(source);
				}
			} else {
				const raw =
					event.subtype === "message_changed" || event.subtype === "message_replied"
						? event.message
						: parsed(RawSlackMessageSchema, envelope.event);
				if (!raw || raw.hidden) return "ignored";
				const message = slackMessage(raw, audience);
				if (this.accept(checkpoint, message)) batch.messages.push(message);
			}
			checkpoint.eventIds = [...checkpoint.eventIds.slice(-2047), envelope.event_id];
			await this.commit(credential, checkpoint, batch, bounded);
			return batch.messages.length || batch.deletions.length ? "applied" : "duplicate";
		});
	}
	/** Real API poll fallback: one bounded page; callers schedule fairly and honor rate-limit errors. */
	poll(
		input: { conversationId: string; threadTs?: string; lookbackSeconds?: number },
		signal?: AbortSignal
	) {
		return this.serial(signal, async (bounded) => {
			const conversationId = parsed(SlackIdSchema, input.conversationId);
			const threadTs = input.threadTs ? parsed(SlackTsSchema, input.threadTs) : null;
			const lookback = parsed(z.int().min(1).max(86400), input.lookbackSeconds ?? 600);
			const credential = await abortable(this.options.client.credential(), bounded);
			const checkpoint = await this.checkpoint(credential, bounded);
			const key = `${conversationId}:${threadTs ?? "history"}`;
			let poll = checkpoint.polls.find((row) => row.key === key);
			if (!poll) {
				if (checkpoint.polls.length >= 128) throw new SlackError("capacity");
				const latest = clockTs(this.now());
				poll = {
					key,
					conversationId,
					threadTs,
					oldest: clockTs(this.now() - lookback * 1000),
					latest,
					through: latest,
					cursor: null,
					active: true,
				};
				checkpoint.polls.push(poll);
			} else if (!poll.active) {
				const latest = clockTs(this.now());
				Object.assign(poll, {
					oldest: clockTs(new Date(slackDate(poll.through)).getTime() - lookback * 1000),
					latest,
					through: latest,
					cursor: null,
					active: true,
				});
			}
			const read = {
				conversationId,
				oldest: poll.oldest,
				latest: poll.latest,
				cursor: poll.cursor ?? undefined,
				inclusive: false,
			};
			const page = threadTs
				? await this.options.client.thread({ ...read, threadTs }, bounded)
				: await this.options.client.history(read, bounded);
			const messages = page.items.filter((message) => this.accept(checkpoint, message));
			if (page.hasMore) {
				if (page.nextCursor) {
					if (page.nextCursor === poll.cursor) throw new SlackError("invalid-data");
					poll.cursor = page.nextCursor;
				} else {
					const timestamps = page.items
						.filter((row) => !threadTs || row.citation.source.messageId !== threadTs)
						.map((row) => row.citation.source.messageId)
						.sort(compareTs);
					const boundary = threadTs ? timestamps.at(-1) : timestamps[0];
					if (
						!boundary ||
						(threadTs
							? compareTs(boundary, poll.oldest) <= 0
							: compareTs(boundary, poll.latest) >= 0)
					)
						throw new SlackError("invalid-data");
					if (threadTs) poll.oldest = boundary;
					else poll.latest = boundary;
					poll.cursor = null;
				}
			} else {
				poll.active = false;
				poll.cursor = null;
			}
			await this.commit(
				credential,
				checkpoint,
				{ connectionId: credential.connectionId, messages, deletions: [] },
				bounded
			);
			return {
				imported: messages.length,
				hasMore: page.hasMore,
				nextCursor: poll.cursor,
				threadIds: page.threadIds,
				coverage: "bounded-poll-no-delete-proof" as const,
			};
		});
	}
}
