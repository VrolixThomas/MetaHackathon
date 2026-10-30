import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import { z } from "zod";
import { sourceShapeAllowed } from "../knowledge/policy";
import type { FactQuery, KnowledgeStorePort, KnowledgeTransaction } from "../knowledge/ports";
import {
	ActorSchema,
	type AdmissionAudit,
	type DirectAgentMessage,
	FactSchema,
	type KnowledgeFact,
	type KnowledgeSource,
	MessageSchema,
	SearchInputSchema,
	SourceSchema,
} from "../knowledge/types";

export const KNOWLEDGE_STORE_LIMITS = Object.freeze({
	rowBytes: 512 * 1024,
	workspaceBytes: 64 * 1024 * 1024,
	totalBytes: 256 * 1024 * 1024,
	workspaces: 64,
	sources: 10_000,
	facts: 10_000,
	messages: 10_000,
	audits: 20_000,
	edges: 640_000,
});

/** Root applies this additive migration on its existing better-sqlite3 connection. */
export const KNOWLEDGE_STORE_MIGRATION_SQL = `
	CREATE TABLE IF NOT EXISTS knowledge_sources (
		workspace_id TEXT NOT NULL, source_id TEXT NOT NULL,
		sequence INTEGER NOT NULL CHECK(sequence>0),
		data_json TEXT NOT NULL CHECK(length(CAST(data_json AS BLOB))<=${KNOWLEDGE_STORE_LIMITS.rowBytes}),
		PRIMARY KEY(workspace_id,source_id)
	);
	CREATE TABLE IF NOT EXISTS knowledge_facts (
		workspace_id TEXT NOT NULL, fact_id TEXT NOT NULL, scope_key TEXT NOT NULL,
		search_text TEXT NOT NULL, created_at TEXT NOT NULL,
		data_json TEXT NOT NULL CHECK(length(CAST(data_json AS BLOB))<=${KNOWLEDGE_STORE_LIMITS.rowBytes}),
		PRIMARY KEY(workspace_id,fact_id)
	);
	CREATE INDEX IF NOT EXISTS knowledge_facts_scope ON knowledge_facts(workspace_id,scope_key,created_at,fact_id);
	CREATE TABLE IF NOT EXISTS knowledge_fact_edges (
		workspace_id TEXT NOT NULL, fact_id TEXT NOT NULL, target_id TEXT NOT NULL,
		kind TEXT NOT NULL CHECK(kind IN ('supersedes','contradicts')),
		PRIMARY KEY(workspace_id,kind,target_id,fact_id),
		FOREIGN KEY(workspace_id,fact_id) REFERENCES knowledge_facts(workspace_id,fact_id)
	);
	CREATE TABLE IF NOT EXISTS knowledge_messages (
		workspace_id TEXT NOT NULL, message_id TEXT NOT NULL, sender_agent_id TEXT NOT NULL,
		request_id TEXT NOT NULL, recipient_agent_id TEXT NOT NULL, created_at TEXT NOT NULL,
		data_json TEXT NOT NULL CHECK(length(CAST(data_json AS BLOB))<=${KNOWLEDGE_STORE_LIMITS.rowBytes}),
		PRIMARY KEY(workspace_id,message_id),
		UNIQUE(workspace_id,sender_agent_id,request_id)
	);
	CREATE INDEX IF NOT EXISTS knowledge_messages_inbox ON knowledge_messages(workspace_id,recipient_agent_id,created_at,message_id);
	CREATE TABLE IF NOT EXISTS knowledge_audits (
		workspace_id TEXT NOT NULL, audit_sequence INTEGER NOT NULL CHECK(audit_sequence>0),
		data_json TEXT NOT NULL CHECK(length(CAST(data_json AS BLOB))<=${KNOWLEDGE_STORE_LIMITS.rowBytes}),
		PRIMARY KEY(workspace_id,audit_sequence)
	);
`;

const FAILURE = "Knowledge storage operation rejected; existing records were preserved";
const KeySchema = ActorSchema.shape.workspaceId;
const AuditSchema: z.ZodType<AdmissionAudit> = z.strictObject({
	workspaceId: KeySchema,
	sender: ActorSchema,
	requestId: KeySchema,
	recipientAgentId: KeySchema,
	at: z.iso.datetime(),
	result: z.discriminatedUnion("status", [
		z.strictObject({ status: z.literal("admitted"), messageId: KeySchema }),
		z.strictObject({
			status: z.literal("rejected"),
			reason: z.enum(["not-authorized", "request-conflict"]),
		}),
	]),
	payloadDigest: MessageSchema.shape.payloadDigest,
});
const tables = ["sources", "facts", "messages", "audits"] as const;
type FactRow = {
	fact_id: string;
	scope_key: string;
	search_text: string;
	created_at: string;
	data_json: string;
};
type MessageRow = {
	message_id: string;
	sender_agent_id: string;
	request_id: string;
	recipient_agent_id: string;
	created_at: string;
	data_json: string;
};
function requireValid(condition: unknown): asserts condition {
	if (!condition) throw new Error(FAILURE);
}
function decode<T>(json: string, schema: z.ZodType<T>): T {
	requireValid(
		typeof json === "string" && Buffer.byteLength(json) <= KNOWLEDGE_STORE_LIMITS.rowBytes
	);
	return schema.parse(JSON.parse(json));
}
function encode<T>(input: T, schema: z.ZodType<T>): { value: T; json: string } {
	// Validate the original shape too: toJSON/extra fields must never hide a rejected payload.
	const parsed = schema.parse(input);
	requireValid(Buffer.byteLength(JSON.stringify(input)) <= KNOWLEDGE_STORE_LIMITS.rowBytes);
	const json = JSON.stringify(parsed);
	return { value: decode(json, schema), json };
}
function messageKey(message: DirectAgentMessage) {
	return JSON.stringify([
		message.sender.agentId,
		message.requestId,
		message.id,
		message.payloadDigest,
	]);
}

/** Durable storage only. Fresh source/actor authority belongs to root's authorization port. */
export class KnowledgeStore implements KnowledgeStorePort {
	constructor(private readonly sqlite: Database.Database) {}

	async transaction<T>(workspaceInput: string, run: (tx: KnowledgeTransaction) => T): Promise<T> {
		let workspaceId: string;
		try {
			workspaceId = KeySchema.parse(workspaceInput);
			requireValid(typeof run === "function" && !this.sqlite.inTransaction);
		} catch {
			throw new Error(FAILURE);
		}
		// A synchronous immediate transaction serializes writers across connections as well.
		return this.sqlite
			.transaction(() => {
				let active = true;
				const inserted: DirectAgentMessage[] = [];
				const audited = new Set<string>();
				const method =
					<A extends unknown[], R>(operation: (...args: A) => R) =>
					(...args: A): R => {
						requireValid(active);
						try {
							return operation(...args);
						} catch {
							throw new Error(FAILURE);
						}
					};
				try {
					this.checkBounds(workspaceId);
					const tx = this.methods(workspaceId, method, inserted, audited);
					const result = run(tx);
					if (
						result !== null &&
						(typeof result === "object" || typeof result === "function") &&
						"then" in result &&
						typeof result.then === "function"
					) {
						// Observe rejection, including a continuation attempting to use the expired handle.
						void Promise.resolve(result).catch(() => {});
						throw new Error("Knowledge transaction callback must be synchronous");
					}
					const detached = structuredClone(result);
					for (const message of inserted) requireValid(audited.has(messageKey(message)));
					this.checkBounds(workspaceId);
					return detached;
				} finally {
					active = false;
				}
			})
			.immediate();
	}

	private checkBounds(workspaceId: string) {
		try {
			let workspaceBytes = 0;
			let totalBytes = 0;
			for (const table of tables) {
				const usage = this.sqlite
					.prepare(`
					SELECT count(*) AS total_count,
					coalesce(sum(length(CAST(data_json AS BLOB))),0) AS total_bytes,
					coalesce(sum(CASE WHEN workspace_id=? THEN 1 ELSE 0 END),0) AS workspace_count,
					coalesce(sum(CASE WHEN workspace_id=? THEN length(CAST(data_json AS BLOB)) ELSE 0 END),0) AS workspace_bytes,
					coalesce(max(length(CAST(data_json AS BLOB))),0) AS max_bytes
					FROM knowledge_${table}
				`)
					.get(workspaceId, workspaceId) as {
					total_count: number;
					total_bytes: number;
					workspace_count: number;
					workspace_bytes: number;
					max_bytes: number;
				};
				requireValid(
					usage.workspace_count <= KNOWLEDGE_STORE_LIMITS[table] &&
						usage.total_count <=
							KNOWLEDGE_STORE_LIMITS[table] * KNOWLEDGE_STORE_LIMITS.workspaces &&
						usage.max_bytes <= KNOWLEDGE_STORE_LIMITS.rowBytes
				);
				workspaceBytes += usage.workspace_bytes;
				totalBytes += usage.total_bytes;
			}
			const edges = this.sqlite
				.prepare(`
				SELECT count(*) AS total_count,
				coalesce(sum(CASE WHEN workspace_id=? THEN 1 ELSE 0 END),0) AS workspace_count
				FROM knowledge_fact_edges
			`)
				.get(workspaceId) as { total_count: number; workspace_count: number };
			requireValid(
				edges.workspace_count <= KNOWLEDGE_STORE_LIMITS.edges &&
					edges.total_count <= KNOWLEDGE_STORE_LIMITS.edges * KNOWLEDGE_STORE_LIMITS.workspaces
			);
			const workspaces = this.sqlite
				.prepare(`
				SELECT count(*) AS count FROM (
					SELECT workspace_id FROM knowledge_sources UNION SELECT workspace_id FROM knowledge_facts
					UNION SELECT workspace_id FROM knowledge_messages UNION SELECT workspace_id FROM knowledge_audits
					UNION SELECT workspace_id FROM knowledge_fact_edges
				)
			`)
				.get() as { count: number };
			requireValid(
				workspaces.count <= KNOWLEDGE_STORE_LIMITS.workspaces &&
					workspaceBytes <= KNOWLEDGE_STORE_LIMITS.workspaceBytes &&
					totalBytes <= KNOWLEDGE_STORE_LIMITS.totalBytes
			);
		} catch {
			throw new Error(FAILURE);
		}
	}

	private methods(
		workspaceId: string,
		method: <A extends unknown[], R>(operation: (...args: A) => R) => (...args: A) => R,
		inserted: DirectAgentMessage[],
		audited: Set<string>
	): KnowledgeTransaction {
		const factValue = (row: FactRow) => {
			const fact = decode(row.data_json, FactSchema);
			requireValid(
				fact.workspaceId === workspaceId &&
					fact.createdBy.workspaceId === workspaceId &&
					fact.id === row.fact_id &&
					JSON.stringify(fact.scope) === row.scope_key &&
					fact.text === row.search_text &&
					fact.createdAt === row.created_at
			);
			return fact;
		};
		const messageValue = (row: MessageRow) => {
			const message = decode(row.data_json, MessageSchema);
			requireValid(
				message.workspaceId === workspaceId &&
					message.sender.workspaceId === workspaceId &&
					message.id === row.message_id &&
					message.sender.agentId === row.sender_agent_id &&
					message.requestId === row.request_id &&
					message.recipientAgentId === row.recipient_agent_id &&
					message.createdAt === row.created_at
			);
			return message;
		};
		const tx: KnowledgeTransaction = {
			getSource: method((sourceId: string) => {
				const id = KeySchema.parse(sourceId);
				const row = this.sqlite
					.prepare(
						"SELECT sequence,data_json FROM knowledge_sources WHERE workspace_id=? AND source_id=?"
					)
					.get(workspaceId, id) as { sequence: number; data_json: string } | undefined;
				if (!row) return null;
				const source = decode(row.data_json, SourceSchema);
				requireValid(
					source.workspaceId === workspaceId &&
						source.sourceId === id &&
						source.sequence === row.sequence &&
						Number.isSafeInteger(source.sequence) &&
						sourceShapeAllowed(source)
				);
				return source;
			}),
			putSource: method((input: KnowledgeSource) => {
				const { value } = encode(input, SourceSchema);
				if (value.state !== "active") value.text = null;
				requireValid(
					value.workspaceId === workspaceId &&
						Number.isSafeInteger(value.sequence) &&
						sourceShapeAllowed(value)
				);
				const previous = tx.getSource(value.sourceId);
				if (previous) {
					requireValid(value.sequence >= previous.sequence);
					if (value.sequence === previous.sequence) {
						requireValid(isDeepStrictEqual(value, previous));
						return;
					}
					requireValid(previous.state !== "deleted" || value.state === "deleted");
					if (
						previous.state === "active" &&
						value.state === "active" &&
						previous.revision === value.revision
					)
						requireValid(previous.text === value.text);
				}
				this.sqlite
					.prepare(
						"INSERT INTO knowledge_sources(workspace_id,source_id,sequence,data_json) VALUES(?,?,?,?) ON CONFLICT(workspace_id,source_id) DO UPDATE SET sequence=excluded.sequence,data_json=excluded.data_json"
					)
					.run(workspaceId, value.sourceId, value.sequence, JSON.stringify(value));
			}),
			getFact: method((id: string) => {
				const row = this.sqlite
					.prepare("SELECT * FROM knowledge_facts WHERE workspace_id=? AND fact_id=?")
					.get(workspaceId, KeySchema.parse(id)) as FactRow | undefined;
				return row ? factValue(row) : null;
			}),
			insertFact: method((input: KnowledgeFact) => {
				const { value, json } = encode(input, FactSchema);
				requireValid(
					value.workspaceId === workspaceId && value.createdBy.workspaceId === workspaceId
				);
				this.sqlite
					.prepare(
						"INSERT INTO knowledge_facts(workspace_id,fact_id,scope_key,search_text,created_at,data_json) VALUES(?,?,?,?,?,?)"
					)
					.run(
						workspaceId,
						value.id,
						JSON.stringify(value.scope),
						value.text,
						value.createdAt,
						json
					);
				const edge = this.sqlite.prepare(
					"INSERT INTO knowledge_fact_edges(workspace_id,fact_id,target_id,kind) VALUES(?,?,?,?)"
				);
				for (const kind of ["supersedes", "contradicts"] as const)
					for (const id of new Set(value[kind])) edge.run(workspaceId, value.id, id, kind);
			}),
			queryFacts: method((input: FactQuery) => {
				const query = SearchInputSchema.parse(input);
				const rows = this.sqlite
					.prepare(
						"SELECT * FROM knowledge_facts WHERE workspace_id=? AND scope_key=? AND instr(search_text,?)>0 ORDER BY created_at DESC,fact_id LIMIT ?"
					)
					.all(workspaceId, JSON.stringify(query.scope), query.text, query.limit) as FactRow[];
				return rows.map((row) => {
					const value = factValue(row);
					requireValid(value.text.includes(query.text));
					return value;
				});
			}),
			getRelatedFactIds: method((input: string) => {
				const id = KeySchema.parse(input);
				const related = (kind: "supersedes" | "contradicts") => {
					const rows = this.sqlite
						.prepare(
							"SELECT fact_id FROM knowledge_fact_edges WHERE workspace_id=? AND kind=? AND target_id=? ORDER BY fact_id LIMIT 257"
						)
						.all(workspaceId, kind, id) as { fact_id: string }[];
					requireValid(rows.length <= 256);
					return rows.map((row) => {
						const value = tx.getFact(row.fact_id);
						requireValid(value?.[kind].includes(id));
						return row.fact_id;
					});
				};
				return { supersededBy: related("supersedes"), contradictedBy: related("contradicts") };
			}),
			getMessageByRequest: method((senderAgentId: string, requestId: string) => {
				const row = this.sqlite
					.prepare(
						"SELECT * FROM knowledge_messages WHERE workspace_id=? AND sender_agent_id=? AND request_id=?"
					)
					.get(workspaceId, KeySchema.parse(senderAgentId), KeySchema.parse(requestId)) as
					| MessageRow
					| undefined;
				return row ? messageValue(row) : null;
			}),
			insertMessage: method((input: DirectAgentMessage) => {
				const { value, json } = encode(input, MessageSchema);
				requireValid(value.workspaceId === workspaceId && value.sender.workspaceId === workspaceId);
				this.sqlite
					.prepare(
						"INSERT INTO knowledge_messages(workspace_id,message_id,sender_agent_id,request_id,recipient_agent_id,created_at,data_json) VALUES(?,?,?,?,?,?,?)"
					)
					.run(
						workspaceId,
						value.id,
						value.sender.agentId,
						value.requestId,
						value.recipientAgentId,
						value.createdAt,
						json
					);
				inserted.push(value);
			}),
			listMessages: method((recipientAgentId: string, limit: number) => {
				const rows = this.sqlite
					.prepare(
						"SELECT * FROM knowledge_messages WHERE workspace_id=? AND recipient_agent_id=? ORDER BY created_at DESC,message_id LIMIT ?"
					)
					.all(
						workspaceId,
						KeySchema.parse(recipientAgentId),
						z.number().int().min(1).max(50).parse(limit)
					) as MessageRow[];
				return rows.map(messageValue);
			}),
			appendAudit: method((input: AdmissionAudit) => {
				const { value, json } = encode(input, AuditSchema);
				requireValid(value.workspaceId === workspaceId && value.sender.workspaceId === workspaceId);
				let admittedKey: string | undefined;
				if (value.result.status === "admitted") {
					const message = tx.getMessageByRequest(value.sender.agentId, value.requestId);
					requireValid(
						message &&
							message.id === value.result.messageId &&
							message.payloadDigest === value.payloadDigest &&
							message.recipientAgentId === value.recipientAgentId &&
							isDeepStrictEqual(message.sender, value.sender)
					);
					admittedKey = messageKey(message);
				}
				this.sqlite
					.prepare(
						"INSERT INTO knowledge_audits(workspace_id,audit_sequence,data_json) SELECT ?,coalesce(max(audit_sequence),0)+1,? FROM knowledge_audits WHERE workspace_id=?"
					)
					.run(workspaceId, json, workspaceId);
				if (admittedKey) audited.add(admittedKey);
			}),
		};
		return tx;
	}
}
