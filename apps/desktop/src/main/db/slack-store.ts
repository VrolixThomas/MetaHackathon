import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
	type ChatMessage,
	ChatMessageSchema,
	type ChatSource,
	ChatSourceSchema,
} from "../../shared/contracts/chat";
import { DayActorSchema } from "../../shared/contracts/day";
import { type SlackCheckpoint, SlackCheckpointSchema } from "../slack/intake";
import { SlackIdSchema, SlackTsSchema, compareTs } from "../slack/types";

export const SlackIdentitySchema = DayActorSchema.extend({
	connectionId: z.string().min(1).max(200),
	appId: SlackIdSchema,
});
export type SlackIdentity = z.infer<typeof SlackIdentitySchema>;
export interface SlackLease extends SlackIdentity {
	epoch: number;
}
export const SlackClassificationSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }),
	z.object({
		kind: z.enum(["request", "promise", "follow_up", "coding"]),
		title: z.string().min(1).max(300),
		summary: z.string().max(12000),
		repositoryId: z.string().min(1).max(200).nullable().default(null),
		questions: z.array(z.string().min(1).max(4000)).max(30).default([]),
		priorityRank: z.int().min(0).max(100).optional(),
		priorityReason: z.string().max(2000).optional(),
	}),
]);
export type SlackClassification = z.infer<typeof SlackClassificationSchema>;
export const SlackSourceRecordSchema = z
	.strictObject({
		sequence: z.int().positive(),
		source: ChatSourceSchema,
		message: ChatMessageSchema.nullable(),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
		deleted: z.boolean(),
		decision: SlackClassificationSchema.nullable(),
		ownPromise: z.boolean(),
		dayApplied: z.boolean(),
		knowledgeApplied: z.boolean(),
	})
	.superRefine((row, ctx) => {
		const invalid = () => ctx.addIssue({ code: "custom", message: "Invalid private source cache" });
		if (
			row.message &&
			(JSON.stringify(row.message.citation.source) !== JSON.stringify(row.source) ||
				row.deleted !== !!row.message.deletedAt ||
				row.digest !== slackMessageDigest(row.message))
		)
			invalid();
		if (!row.message && !row.deleted) invalid();
		if (
			row.ownPromise &&
			(row.decision?.kind !== "promise" || !row.message || row.message.truncated || row.deleted)
		)
			invalid();
	});
export type SlackSourceRecord = z.infer<typeof SlackSourceRecordSchema>;
export const SlackPreferencesSchema = z
	.strictObject({
		sequence: z.int().nonnegative(),
		conversationIds: z.array(SlackIdSchema).max(32),
		threads: z
			.array(z.strictObject({ conversationId: SlackIdSchema, threadTs: SlackTsSchema }))
			.max(96),
		nextStream: z.int().nonnegative(),
		nextHistoryAt: z.number().finite().nonnegative().default(0),
		nextRepliesAt: z.number().finite().nonnegative().default(0),
		rateLimitedUntil: z.number().finite().nonnegative().default(0),
	})
	.refine(
		(row) =>
			new Set(row.conversationIds).size === row.conversationIds.length &&
			new Set(row.threads.map((t) => `${t.conversationId}:${t.threadTs}`)).size ===
				row.threads.length &&
			row.threads.every((t) => row.conversationIds.includes(t.conversationId)),
		"Unique watched stream identities required"
	);
export type SlackPreferences = z.infer<typeof SlackPreferencesSchema>;
export const emptySlackPreferences = (): SlackPreferences => ({
	sequence: 0,
	conversationIds: [],
	threads: [],
	nextStream: 0,
	nextHistoryAt: 0,
	nextRepliesAt: 0,
	rateLimitedUntil: 0,
});
export interface SlackWorkspaceStorePort {
	head(): Promise<{ epoch: number; identity: SlackIdentity | null }>;
	activate(identity: SlackIdentity, expectedEpoch: number): Promise<SlackLease>;
	release(lease: SlackLease): Promise<void>;
	checkpoint(lease: SlackLease): Promise<{ sequence: number; data: SlackCheckpoint } | null>;
	saveCheckpoint(lease: SlackLease, data: SlackCheckpoint, expectedSequence: number): Promise<void>;
	preferences(lease: SlackLease): Promise<SlackPreferences>;
	savePreferences(
		lease: SlackLease,
		preferences: SlackPreferences,
		expectedSequence: number
	): Promise<void>;
	source(lease: SlackLease, source: ChatSource): Promise<SlackSourceRecord | null>;
	saveSource(lease: SlackLease, record: SlackSourceRecord, expectedSequence: number): Promise<void>;
	pending(
		lease: SlackLease,
		limit: number,
		conversationIds?: readonly string[]
	): Promise<SlackSourceRecord[]>;
}
export class SlackStoreError extends Error {
	constructor(readonly code: "conflict" | "invalid-data" | "capacity" = "invalid-data") {
		super("Slack workspace storage rejected this operation; existing records were preserved.");
	}
}
export function slackSourceKey(source: ChatSource): string {
	return createHash("sha256")
		.update(
			JSON.stringify([source.provider, source.workspaceId, source.conversationId, source.messageId])
		)
		.digest("hex");
}
export function slackMessageDigest(message: ChatMessage): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				message.citation.source,
				message.authorId,
				message.text,
				message.createdAt,
				message.updatedAt,
				message.deletedAt,
				message.truncated,
			])
		)
		.digest("hex");
}
const actorKey = (identity: SlackIdentity) =>
	JSON.stringify([identity.workspaceId, identity.userId]);
const ROW_BYTES = 512 * 1024;
export const SLACK_STORE_MIGRATION_SQL = `
 CREATE TABLE IF NOT EXISTS slack_workspace_head(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,identity_json TEXT);
 CREATE TABLE IF NOT EXISTS slack_workspace_connections(connection_id TEXT PRIMARY KEY,identity_json TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,checkpoint_json TEXT);
 CREATE TABLE IF NOT EXISTS slack_workspace_preferences(actor_key TEXT PRIMARY KEY,sequence INTEGER NOT NULL,data_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS slack_workspace_sources(actor_key TEXT NOT NULL,source_key TEXT NOT NULL,sequence INTEGER NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(actor_key,source_key));
`;
function requireValid(
	condition: unknown,
	code: "conflict" | "invalid-data" | "capacity" = "invalid-data"
): asserts condition {
	if (!condition) throw new SlackStoreError(code);
}
function encode<T>(
	schema: z.ZodType<T>,
	input: unknown,
	maxBytes = ROW_BYTES
): { value: T; json: string } {
	try {
		const value = schema.parse(input);
		const json = JSON.stringify(value);
		requireValid(Buffer.byteLength(json) <= maxBytes, "capacity");
		return { value, json };
	} catch (error) {
		throw error instanceof SlackStoreError ? error : new SlackStoreError();
	}
}
function decode<T>(schema: z.ZodType<T>, json: string, maxBytes = ROW_BYTES): T {
	requireValid(typeof json === "string" && Buffer.byteLength(json) <= maxBytes);
	return schema.parse(JSON.parse(json));
}

/** Root owns connection/migration/lifetime. This adapter opens/closes nothing and stores no credentials. */
export class SlackWorkspaceStore implements SlackWorkspaceStorePort {
	constructor(private readonly sqlite: Database.Database) {}
	private run<T>(operation: () => T): T {
		try {
			requireValid(!this.sqlite.inTransaction);
			return this.sqlite.transaction(operation).immediate();
		} catch (error) {
			throw error instanceof SlackStoreError ? error : new SlackStoreError();
		}
	}
	private readHead() {
		const row = this.sqlite
			.prepare("SELECT epoch,identity_json FROM slack_workspace_head WHERE id=1")
			.get() as { epoch: number; identity_json: string | null } | undefined;
		requireValid(!row || (Number.isSafeInteger(row.epoch) && row.epoch >= 0));
		return {
			epoch: row?.epoch ?? 0,
			identity: row?.identity_json ? decode(SlackIdentitySchema, row.identity_json, 4096) : null,
		};
	}
	private assertLease(lease: SlackLease) {
		const identity = SlackIdentitySchema.parse({
			connectionId: lease.connectionId,
			workspaceId: lease.workspaceId,
			userId: lease.userId,
			appId: lease.appId,
		});
		const head = this.readHead();
		requireValid(
			head.epoch === lease.epoch && JSON.stringify(head.identity) === JSON.stringify(identity),
			"conflict"
		);
	}
	async head() {
		return this.run(() => this.readHead());
	}
	async activate(input: SlackIdentity, expectedEpoch: number): Promise<SlackLease> {
		const { value: identity, json } = encode(SlackIdentitySchema, input, 4096);
		return this.run(() => {
			const head = this.readHead();
			requireValid(
				head.epoch === expectedEpoch && Number.isSafeInteger(expectedEpoch + 1),
				"conflict"
			);
			const row = this.sqlite
				.prepare("SELECT identity_json FROM slack_workspace_connections WHERE connection_id=?")
				.get(identity.connectionId) as { identity_json: string } | undefined;
			if (row) requireValid(row.identity_json === json, "conflict");
			else {
				const count = this.sqlite
					.prepare("SELECT count(*) AS count FROM slack_workspace_connections")
					.get() as { count: number };
				requireValid(count.count < 32, "capacity");
				this.sqlite
					.prepare(
						"INSERT INTO slack_workspace_connections(connection_id,identity_json) VALUES(?,?)"
					)
					.run(identity.connectionId, json);
			}
			this.sqlite
				.prepare(
					"INSERT INTO slack_workspace_head(id,epoch,identity_json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,identity_json=excluded.identity_json"
				)
				.run(expectedEpoch + 1, json);
			return { ...identity, epoch: expectedEpoch + 1 };
		});
	}
	async release(lease: SlackLease): Promise<void> {
		this.run(() => {
			this.assertLease(lease);
			this.sqlite
				.prepare("UPDATE slack_workspace_head SET epoch=epoch+1,identity_json=NULL WHERE id=1")
				.run();
		});
	}
	async checkpoint(lease: SlackLease) {
		return this.run(() => {
			this.assertLease(lease);
			const row = this.sqlite
				.prepare(
					"SELECT sequence,checkpoint_json FROM slack_workspace_connections WHERE connection_id=?"
				)
				.get(lease.connectionId) as { sequence: number; checkpoint_json: string | null };
			if (!row.checkpoint_json) return null;
			const data = decode(SlackCheckpointSchema, row.checkpoint_json, 8 * 1024 * 1024);
			requireValid(
				data.connectionId === lease.connectionId &&
					data.workspaceId === lease.workspaceId &&
					data.userId === lease.userId
			);
			return { sequence: row.sequence, data };
		});
	}
	async saveCheckpoint(
		lease: SlackLease,
		input: SlackCheckpoint,
		expectedSequence: number
	): Promise<void> {
		const { value: next, json } = encode(SlackCheckpointSchema, input, 8 * 1024 * 1024);
		this.run(() => {
			this.assertLease(lease);
			requireValid(
				next.connectionId === lease.connectionId &&
					next.workspaceId === lease.workspaceId &&
					next.userId === lease.userId
			);
			const row = this.sqlite
				.prepare(
					"SELECT sequence,checkpoint_json FROM slack_workspace_connections WHERE connection_id=?"
				)
				.get(lease.connectionId) as { sequence: number; checkpoint_json: string | null };
			requireValid(row.sequence === expectedSequence, "conflict");
			if (row.checkpoint_json) {
				const old = decode(SlackCheckpointSchema, row.checkpoint_json, 8 * 1024 * 1024);
				for (const previous of old.revisions) {
					const current = next.revisions.find((r) => r.key === previous.key);
					requireValid(
						current &&
							(!previous.deleted || current.deleted) &&
							(current.deleted || compareTs(current.revisionId, previous.revisionId) >= 0),
						"conflict"
					);
				}
				for (const previous of old.polls) {
					const current = next.polls.find((p) => p.key === previous.key);
					requireValid(current && compareTs(current.through, previous.through) >= 0, "conflict");
				}
			}
			this.sqlite
				.prepare(
					"UPDATE slack_workspace_connections SET sequence=?,checkpoint_json=? WHERE connection_id=?"
				)
				.run(expectedSequence + 1, json, lease.connectionId);
		});
	}
	async preferences(lease: SlackLease): Promise<SlackPreferences> {
		return this.run(() => {
			this.assertLease(lease);
			const row = this.sqlite
				.prepare("SELECT sequence,data_json FROM slack_workspace_preferences WHERE actor_key=?")
				.get(actorKey(lease)) as { sequence: number; data_json: string } | undefined;
			if (!row) return emptySlackPreferences();
			const result = decode(SlackPreferencesSchema, row.data_json);
			requireValid(row.sequence === result.sequence);
			return result;
		});
	}
	async savePreferences(
		lease: SlackLease,
		input: SlackPreferences,
		expectedSequence: number
	): Promise<void> {
		const { value, json } = encode(SlackPreferencesSchema, input);
		this.run(() => {
			this.assertLease(lease);
			const row = this.sqlite
				.prepare("SELECT sequence FROM slack_workspace_preferences WHERE actor_key=?")
				.get(actorKey(lease)) as { sequence: number } | undefined;
			requireValid(
				(row?.sequence ?? 0) === expectedSequence && value.sequence === expectedSequence + 1,
				"conflict"
			);
			const count = this.sqlite
				.prepare("SELECT count(*) AS count FROM slack_workspace_preferences")
				.get() as { count: number };
			requireValid(row || count.count < 32, "capacity");
			this.sqlite
				.prepare(
					"INSERT INTO slack_workspace_preferences(actor_key,sequence,data_json) VALUES(?,?,?) ON CONFLICT(actor_key) DO UPDATE SET sequence=excluded.sequence,data_json=excluded.data_json"
				)
				.run(actorKey(lease), value.sequence, json);
		});
	}
	private readSource(lease: SlackLease, source: ChatSource): SlackSourceRecord | null {
		const row = this.sqlite
			.prepare(
				"SELECT sequence,data_json FROM slack_workspace_sources WHERE actor_key=? AND source_key=?"
			)
			.get(actorKey(lease), slackSourceKey(source)) as
			| { sequence: number; data_json: string }
			| undefined;
		if (!row) return null;
		const result = decode(SlackSourceRecordSchema, row.data_json);
		requireValid(
			row.sequence === result.sequence &&
				slackSourceKey(result.source) === slackSourceKey(source) &&
				result.source.workspaceId === lease.workspaceId
		);
		return result;
	}
	async source(lease: SlackLease, source: ChatSource) {
		return this.run(() => {
			this.assertLease(lease);
			return this.readSource(lease, ChatSourceSchema.parse(source));
		});
	}
	async saveSource(
		lease: SlackLease,
		input: SlackSourceRecord,
		expectedSequence: number
	): Promise<void> {
		const { value, json } = encode(SlackSourceRecordSchema, input);
		this.run(() => {
			this.assertLease(lease);
			requireValid(
				value.source.workspaceId === lease.workspaceId &&
					value.sequence === expectedSequence + 1 &&
					(!value.ownPromise || value.message?.authorId === lease.userId)
			);
			const previous = this.readSource(lease, value.source);
			requireValid((previous?.sequence ?? 0) === expectedSequence, "conflict");
			if (previous) {
				requireValid(!previous.deleted || value.deleted, "conflict");
				requireValid(
					value.deleted || compareTs(value.source.revisionId, previous.source.revisionId) >= 0,
					"conflict"
				);
				if (value.source.revisionId === previous.source.revisionId && !value.deleted) {
					requireValid(value.digest === previous.digest, "conflict");
					if (previous.decision)
						requireValid(
							JSON.stringify(value.decision) === JSON.stringify(previous.decision) &&
								value.ownPromise === previous.ownPromise,
							"conflict"
						);
				}
			}
			const size = this.sqlite
				.prepare(
					"SELECT count(*) AS count,coalesce(sum(length(CAST(data_json AS BLOB))),0) AS bytes FROM slack_workspace_sources"
				)
				.get() as { count: number; bytes: number };
			requireValid(
				(previous || size.count < 2000) &&
					size.bytes +
						Buffer.byteLength(json) -
						(previous ? Buffer.byteLength(JSON.stringify(previous)) : 0) <=
						32 * 1024 * 1024,
				"capacity"
			);
			this.sqlite
				.prepare(
					"INSERT INTO slack_workspace_sources(actor_key,source_key,sequence,data_json) VALUES(?,?,?,?) ON CONFLICT(actor_key,source_key) DO UPDATE SET sequence=excluded.sequence,data_json=excluded.data_json"
				)
				.run(actorKey(lease), slackSourceKey(value.source), value.sequence, json);
		});
	}
	async pending(
		lease: SlackLease,
		limit: number,
		conversationIds?: readonly string[]
	): Promise<SlackSourceRecord[]> {
		return this.run(() => {
			this.assertLease(lease);
			requireValid(Number.isInteger(limit) && limit >= 1 && limit <= 32);
			const rows = this.sqlite
				.prepare(
					"SELECT data_json FROM slack_workspace_sources WHERE actor_key=? ORDER BY rowid LIMIT 2000"
				)
				.all(actorKey(lease)) as { data_json: string }[];
			return rows
				.map((row) => decode(SlackSourceRecordSchema, row.data_json))
				.filter(
					(row) =>
						(!row.dayApplied || !row.knowledgeApplied) &&
						(!conversationIds || conversationIds.includes(row.source.conversationId))
				)
				.slice(0, limit);
		});
	}
}
