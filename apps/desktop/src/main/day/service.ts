import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	IdSchema,
	type LinearTicket,
	LinearTicketSchema,
	type WorkJob,
	WorkJobSchema,
} from "../../shared/contracts";
import {
	type ChatReplyReceipt,
	ChatReplyReceiptSchema,
	type ChatSource,
	ChatSourceSchema,
} from "../../shared/contracts/chat";
import {
	type DayActor,
	DayActorSchema,
	type DayClarification,
	type DayOperateInput,
	DayOperateInputSchema,
	type DayOperationResult,
	DayOperationResultSchema,
	type DaySnapshot,
	DaySnapshotSchema,
	type DayWorkItem,
} from "../../shared/contracts/day";
import { abortable } from "../agent/cancellation";
import type { DayStore } from "../db/day-store";
import { SlackError } from "../slack/types";
import {
	type ClarificationAnalysis,
	ClarificationAnalysisSchema,
	type ClarificationRead,
	ClarificationReadSchema,
	clarificationDigest,
} from "./clarification";
import {
	type DayCapture,
	DayCaptureSchema,
	type DayOutbox,
	type DayRecord,
	type DayState,
	emptyDayState,
	parseDayState,
	replyMatches,
	sha256,
	sourceKey,
} from "./model";
import { type DayAvailability, DaySupervisor } from "./supervisor";

export interface DayPreparationRequest {
	requestId: string;
	itemId: string;
	repositoryId: string;
	source: ChatSource | null;
	/** Evidence only. Root must keep provider text out of instruction/authorization roles. */
	sourceText: string | null;
	title: string;
	summary: string;
	linear: LinearTicket | null;
	policy: "isolated-no-publication";
}
/** Root bridges these to the existing WorkJobCoordinator. There is no worker runtime here. */
export interface DayWorkerPort {
	prepare(input: DayPreparationRequest, signal: AbortSignal): Promise<{ jobId: string }>;
	observe(jobId: string, signal: AbortSignal): Promise<WorkJob | null>;
	execute(jobId: string, requestId: string, signal: AbortSignal): Promise<void>;
	answer(
		jobId: string,
		decisionId: string,
		answer: string,
		requestId: string,
		signal: AbortSignal
	): Promise<void>;
	control(
		jobId: string,
		kind: "pause" | "resume" | "cancel",
		requestId: string,
		signal: AbortSignal
	): Promise<void>;
}
export interface DayReplyRequest {
	clarification?: true;
	clarificationThreadDigest?: string;
	requestId: string;
	source: ChatSource;
	body: string;
}
/** Duck-compatible with SlackReplyLedger; provider reservation is distinct from the outer attempt. */
export interface DayProviderReplyLedger {
	authorize(key: string, bindingDigest: string): Promise<void>;
	reserve(
		key: string,
		bindingDigest: string
	): Promise<
		| { state: "reserved" }
		| { state: "uncertain" }
		| { state: "delivered"; receipt: ChatReplyReceipt }
	>;
	delivered(key: string, bindingDigest: string, receipt: ChatReplyReceipt): Promise<void>;
}
export interface DayReplyPort {
	/** Current identity and complete bounded original-thread read, under fresh membership checks. */
	readClarification?(source: ChatSource, signal: AbortSignal): Promise<ClarificationRead>;
	send(input: DayReplyRequest, signal: AbortSignal): Promise<ChatReplyReceipt>;
	/** not_found must be authoritative. An eventually consistent search miss is uncertain. */
	reconcile(
		input: DayReplyRequest,
		signal: AbortSignal
	): Promise<
		{ status: "delivered"; receipt: ChatReplyReceipt } | { status: "not_found" | "uncertain" }
	>;
}
export interface DayPorts {
	store: Pick<DayStore, "loadState" | "saveState">;
	actor: DayActor;
	availability(): DayAvailability;
	worker?: DayWorkerPort;
	analyzeClarification?(
		clarification: DayClarification,
		read: ClarificationRead,
		signal: AbortSignal
	): Promise<ClarificationAnalysis>;
	replies?: DayReplyPort;
	linearTicket?(issueId: string, signal: AbortSignal): Promise<LinearTicket>;
	now?(): number;
	id?(): string;
	cadenceMs?: number;
	maxBackoffMs?: number;
	operationTimeoutMs?: number;
}
const sameActor = (a: DayActor, b: DayActor) =>
	a.workspaceId === b.workspaceId && a.userId === b.userId;
class DayChanged extends Error {
	constructor() {
		super("This work changed. Refresh it before continuing.");
	}
}
const unavailable = () => new Error("This work or its source is unavailable.");
function revisionOrder(a: string, b: string) {
	if (!/^\d+\.\d{6}$/.test(a) || !/^\d+\.\d{6}$/.test(b)) return null;
	const x = BigInt(a.replace(".", ""));
	const y = BigInt(b.replace(".", ""));
	return x < y ? -1 : x > y ? 1 : 0;
}

/** Durable private commitments. Only trusted user operations grant ownership or authorize a reply. */
export class DayService {
	private state: DayState;
	private readonly actor: DayActor;
	private readonly now: () => number;
	private readonly id: () => string;
	private initialized?: Promise<void>;
	private writes: Promise<unknown> = Promise.resolve();
	private closing = false;
	private disposal?: Promise<void>;
	private readonly lifetime = new AbortController();
	private readonly listeners = new Set<() => void>();
	readonly supervisor: DaySupervisor;
	readonly replyLedger: DayProviderReplyLedger;
	constructor(private readonly ports: DayPorts) {
		this.actor = DayActorSchema.parse(ports.actor);
		this.now = ports.now ?? Date.now;
		this.id = ports.id ?? randomUUID;
		this.state = emptyDayState(this.iso());
		this.replyLedger = {
			authorize: async (key, binding) => {
				this.assertOpen();
				await this.initialize();
				const { record, reply } = this.ledgerReply(this.state, key, binding);
				if (
					reply.providerKey !== key ||
					reply.providerBindingDigest !== binding ||
					!this.replyEligible(record, reply)
				)
					throw unavailable();
			},
			reserve: (key, binding) => this.reserveReply(key, binding),
			delivered: (key, binding, receipt) => this.providerDelivered(key, binding, receipt),
		};
		this.supervisor = new DaySupervisor({
			read: async () => {
				await this.initialize();
				return structuredClone(this.state.supervisor);
			},
			update: (mutator) =>
				this.update((state) => {
					mutator(state.supervisor);
				}),
			cycle: (signal) => this.cycle(signal),
			availability: ports.availability,
			now: this.now,
			cadenceMs: ports.cadenceMs,
			maxBackoffMs: ports.maxBackoffMs,
			operationTimeoutMs: ports.operationTimeoutMs,
		});
	}
	private iso(offset = 0) {
		return new Date(this.now() + offset).toISOString();
	}
	initialize(): Promise<void> {
		this.initialized ??= (async () => {
			this.state = parseDayState((await this.ports.store.loadState()) ?? this.state);
		})();
		return this.initialized;
	}
	async start() {
		this.assertOpen();
		await this.initialize();
		await this.supervisor.start();
	}
	async tick() {
		this.assertOpen();
		await this.initialize();
		await this.supervisor.tick();
	}
	availabilityChanged() {
		return this.supervisor.availabilityChanged();
	}
	subscribe(listener: () => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private assertOpen() {
		if (this.closing) throw unavailable();
	}
	private ensureAvailable(signal: AbortSignal) {
		this.assertOpen();
		signal.throwIfAborted();
		const availability = this.ports.availability();
		if (!availability.awake || !availability.online) throw unavailable();
	}
	private owns(item: DayWorkItem) {
		return item.workspaceId === this.actor.workspaceId && item.ownerUserId === this.actor.userId;
	}
	private record(state: DayState, id: string): DayRecord {
		const record = state.records.find(({ item }) => item.id === id && this.owns(item));
		if (!record) throw unavailable();
		return record;
	}
	private async update<T>(mutator: (state: DayState) => T): Promise<T> {
		await this.initialize();
		const work = this.writes
			.catch(() => {})
			.then(async () => {
				const next = structuredClone(this.state);
				const result = mutator(next);
				next.sequence++;
				const validated = parseDayState(next);
				await this.ports.store.saveState(validated, this.state.sequence);
				this.state = validated;
				for (const listener of this.listeners) {
					try {
						listener();
					} catch {
						/* A listener cannot undo a commit. */
					}
				}
				return structuredClone(result);
			});
		this.writes = work;
		return work;
	}
	async snapshot(): Promise<DaySnapshot> {
		await this.initialize();
		const records = this.state.records.filter(({ item }) => this.owns(item));
		const errors = [
			...new Set(
				records.flatMap((record) => (record.checkpoint.error ? [record.checkpoint.error] : []))
			),
		];
		return DaySnapshotSchema.parse({
			sequence: this.state.sequence,
			actor: this.actor,
			items: records.map((record) => record.item),
			currentItemId:
				this.state.current.find((current) => sameActor(current.actor, this.actor))?.itemId ?? null,
			supervisor:
				this.state.supervisor.mode === "stopped"
					? "stopped"
					: ["sleeping", "offline", "backoff"].includes(this.state.supervisor.mode)
						? "paused"
						: "running",
			errors,
		});
	}
	private replay(state: DayState, requestId: string, digest: string): string | null {
		const prior = state.requests.find(
			(request) => request.id === requestId && sameActor(request.actor, this.actor)
		);
		if (!prior) return null;
		if (prior.digest !== digest)
			throw new Error("A work request ID cannot be reused for different content.");
		return prior.itemId;
	}
	private remember(state: DayState, requestId: string, digest: string, itemId: string) {
		state.requests.push({ id: requestId, digest, itemId, actor: this.actor });
	}
	private touch(record: DayRecord) {
		record.item.revision++;
		record.item.updatedAt = this.iso();
	}
	private due(state: DayState, record: DayRecord) {
		record.item.nextCheckAt = this.iso();
		state.supervisor.nextCheckAt = this.iso();
	}
	private freshItem(input: {
		title: string;
		summary: string;
		kind: DayWorkItem["kind"];
		source: DayWorkItem["source"];
		requestedById: string | null;
		accepted: boolean;
		ownPromise: boolean;
		repositoryId: string | null;
	}): DayRecord {
		const now = this.iso();
		return {
			item: {
				id: this.id(),
				revision: 1,
				workspaceId: this.actor.workspaceId,
				ownerUserId: this.actor.userId,
				requestedById: input.requestedById,
				kind: input.kind,
				title: input.title,
				summary: input.summary,
				source: input.source,
				acceptance: input.accepted ? "accepted" : "pending",
				acceptanceBasis: input.ownPromise
					? "own_explicit_promise"
					: input.accepted
						? "user_action"
						: "none",
				acceptedAt: input.accepted ? now : null,
				phase: "captured",
				priority: {
					rank: 50,
					reason: "Captured work; no source priority has been verified.",
					provenance: "inferred",
				},
				questions: [],
				jobId: null,
				repositoryId: input.repositoryId,
				linearIssueId: null,
				nextCheckAt: now,
				reviewedAt: null,
				reviewedHeadSha: null,
				replyDraft: null,
				answerReceipt: null,
				createdAt: now,
				updatedAt: now,
			},
			sourceUpdatedAt: null,
			sourceDigest: null,
			sourceText: null,
			sourceDeleted: false,
			preparation: null,
			questionDeliveries: [],
			controls: [],
			paused: false,
			linear: null,
			outbox: [],
			checkpoint: { lastAttemptAt: null, lastCompletedAt: null, failures: 0, error: null },
		};
	}
	/** `authority` comes from a trusted user action/classification, never from message text or model output. */
	async capture(
		raw: DayCapture,
		authority?: { explicitOwnPromise: true; actor: DayActor }
	): Promise<DayOperationResult> {
		this.assertOpen();
		const input = DayCaptureSchema.parse(raw);
		const { message } = input;
		if (message.citation.source.workspaceId !== this.actor.workspaceId) throw unavailable();
		if (
			message.citation.audience.visibility !== "public_channel" &&
			!message.citation.audience.readerIds.includes(this.actor.userId)
		)
			throw unavailable();
		const ownPromise =
			!!authority &&
			authority.explicitOwnPromise &&
			sameActor(DayActorSchema.parse(authority.actor), this.actor) &&
			message.authorId === this.actor.userId &&
			input.kind === "promise" &&
			!message.truncated &&
			!message.deletedAt;
		if (authority && !ownPromise)
			throw new Error("An explicit own promise must be attributed to the current user.");
		const digest = sha256(
			JSON.stringify([
				message.citation.source,
				message.authorId,
				message.text,
				message.createdAt,
				message.updatedAt,
				message.deletedAt,
				message.truncated,
				input.kind,
				input.title,
				input.summary,
				input.repositoryId,
				ownPromise,
			])
		);
		const itemId = await this.update((state) => {
			this.assertOpen();
			const replay = this.replay(state, input.requestId, digest);
			if (replay) return replay;
			let record = state.records.find(
				({ item }) =>
					this.owns(item) &&
					item.source &&
					sourceKey(item.source.source) === sourceKey(message.citation.source)
			);
			const sourceDigest = sha256(
				JSON.stringify([message.authorId, message.text, message.deletedAt, message.truncated])
			);
			if (record) {
				const fence = record.sourceFence;
				if (
					record.sourceDeleted ||
					(fence &&
						(fence.deleted ||
							(revisionOrder(message.citation.source.revisionId, fence.revisionId) ??
								(Date.parse(message.updatedAt) < Date.parse(fence.updatedAt)
									? -1
									: message.citation.source.revisionId === fence.revisionId
										? 0
										: -1)) < 0))
				)
					throw new DayChanged();
				if (record.item.source?.source.revisionId === message.citation.source.revisionId) {
					if (record.sourceDigest !== sourceDigest) throw new DayChanged();
					// Re-ingestion cannot retroactively upgrade an incoming candidate into accepted ownership.
					this.remember(state, input.requestId, digest, record.item.id);
					return record.item.id;
				}
				if (
					record.sourceUpdatedAt &&
					(revisionOrder(
						message.citation.source.revisionId,
						record.item.source?.source.revisionId ?? ""
					) ?? (Date.parse(message.updatedAt) <= Date.parse(record.sourceUpdatedAt) ? -1 : 1)) <= 0
				)
					throw new DayChanged();
				if (record.item.jobId)
					record.controls.push({
						requestId: `day-cancel-${sha256(JSON.stringify([record.item.id, record.item.revision]))}`,
						jobId: record.item.jobId,
						kind: "cancel",
						deliveredAt: null,
					});
				for (const reply of record.outbox) reply.superseded = true;
				if (record.item.clarification) {
					record.item.clarification.status = "revoked";
					record.item.clarification.policy.revision++;
				}
				record.item.source = message.citation;
				record.item.title = input.title;
				record.item.summary = input.summary;
				record.item.kind = input.kind;
				record.item.requestedById = message.authorId;
				record.item.acceptance = ownPromise ? "accepted" : "pending";
				record.item.acceptanceBasis = ownPromise ? "own_explicit_promise" : "none";
				record.item.acceptedAt = ownPromise ? this.iso() : null;
				record.item.phase = "captured";
				record.item.jobId = null;
				record.item.repositoryId = input.repositoryId;
				record.item.questions = [];
				record.item.reviewedAt = null;
				record.item.reviewedHeadSha = null;
				record.item.replyDraft = null;
				record.item.answerReceipt = null;
				record.preparation = null;
				record.questionDeliveries = [];
				record.paused = false;
				this.touch(record);
			} else {
				if (message.deletedAt) throw unavailable();
				record = this.freshItem({
					...input,
					source: message.citation,
					requestedById: message.authorId,
					accepted: ownPromise,
					ownPromise,
				});
				state.records.push(record);
			}
			record.sourceUpdatedAt = message.updatedAt;
			record.sourceDigest = sourceDigest;
			record.sourceText = message.deletedAt ? null : message.text;
			record.sourceDeleted = !!message.deletedAt;
			record.item.phase = message.deletedAt ? "cancelled" : "captured";
			if (message.deletedAt) record.item.summary = "The source message is no longer available.";
			this.due(state, record);
			this.remember(state, input.requestId, digest, record.item.id);
			return record.item.id;
		});
		return this.result(input.requestId, itemId);
	}

	/** Trusted connector invalidation, including identity-only deletes; never fabricates a message. */
	async invalidateSource(raw: {
		requestId: string;
		source: ChatSource;
		updatedAt: string;
		deleted?: boolean;
	}): Promise<DayOperationResult> {
		const input = z
			.strictObject({
				requestId: IdSchema,
				source: ChatSourceSchema,
				updatedAt: z.iso.datetime(),
				deleted: z.boolean().default(false),
			})
			.parse(raw);
		if (input.source.workspaceId !== this.actor.workspaceId) throw unavailable();
		const digest = sha256(JSON.stringify(["source-invalidation", input]));
		const id = await this.update((state) => {
			const replay = this.replay(state, input.requestId, digest);
			if (replay) return replay;
			const record = state.records.find(
				(row) =>
					this.owns(row.item) &&
					row.item.source &&
					sourceKey(row.item.source.source) === sourceKey(input.source)
			);
			if (!record) return null;
			if (
				!input.deleted &&
				record.item.source?.source.revisionId === input.source.revisionId &&
				!record.sourceDeleted
			) {
				this.remember(state, input.requestId, digest, record.item.id);
				return record.item.id;
			}
			const previous = record.sourceFence;
			if (
				previous &&
				(revisionOrder(input.source.revisionId, previous.revisionId) ??
					(Date.parse(input.updatedAt) < Date.parse(previous.updatedAt) ? -1 : 0)) < 0
			)
				throw new DayChanged();
			this.cancelRecord(record, input.requestId);
			record.sourceFence = {
				revisionId: input.source.revisionId,
				updatedAt: input.updatedAt,
				deleted: input.deleted || !!previous?.deleted,
			};
			record.sourceDeleted = record.sourceFence.deleted;
			record.sourceText = null;
			if (record.item.clarification) {
				record.item.clarification.evidence = [];
				record.item.clarification.summary = "";
				record.item.clarification.missing = [];
				record.item.clarification.policy.originalRequest = "Source no longer available";
			}
			record.item.title = input.deleted ? "Slack source removed" : "Slack source changed";
			record.item.summary = "";
			record.item.replyDraft = null;
			record.item.reviewedAt = null;
			record.item.reviewedHeadSha = null;
			this.touch(record);
			this.due(state, record);
			this.remember(state, input.requestId, digest, record.item.id);
			return record.item.id;
		});
		return id === null
			? DayOperationResultSchema.parse({
					requestId: input.requestId,
					itemId: null,
					snapshot: await this.snapshot(),
				})
			: this.result(input.requestId, id);
	}
	async setInferredPriority(raw: {
		requestId: string;
		itemId: string;
		expectedRevision: number;
		sourceRevisionId: string;
		rank: number;
		reason: string;
	}): Promise<DayOperationResult> {
		const input = z
			.strictObject({
				requestId: IdSchema,
				itemId: IdSchema,
				expectedRevision: z.int().positive(),
				sourceRevisionId: IdSchema,
				rank: z.int().min(0).max(100),
				reason: z.string().min(1).max(2000),
			})
			.parse(raw);
		const digest = sha256(
			JSON.stringify([
				"source-priority",
				this.actor,
				input.itemId,
				input.sourceRevisionId,
				input.rank,
				input.reason,
			])
		);
		const id = await this.update((state) => {
			const replay = this.replay(state, input.requestId, digest);
			if (replay) return replay;
			const record = this.record(state, input.itemId);
			if (
				record.item.revision !== input.expectedRevision ||
				record.item.source?.source.revisionId !== input.sourceRevisionId ||
				record.sourceDeleted ||
				["closed", "cancelled"].includes(record.item.phase)
			)
				throw new DayChanged();
			record.item.priority = { rank: input.rank, reason: input.reason, provenance: "inferred" };
			this.touch(record);
			this.remember(state, input.requestId, digest, record.item.id);
			return record.item.id;
		});
		return this.result(input.requestId, id);
	}
	private async result(requestId: string, itemId: string): Promise<DayOperationResult> {
		return DayOperationResultSchema.parse({ requestId, itemId, snapshot: await this.snapshot() });
	}
	/** Root may enqueue inferred missing context without creating a coding job or sending a peer question. */
	async queueContext(raw: {
		requestId: string;
		itemId: string;
		expectedRevision: number;
		questions: string[];
	}): Promise<DayOperationResult> {
		this.assertOpen();
		const input = z
			.strictObject({
				requestId: IdSchema,
				itemId: IdSchema,
				expectedRevision: z.int().positive(),
				questions: z.array(z.string().min(1).max(4000)).min(1).max(30),
			})
			.parse(raw);
		const digest = sha256(JSON.stringify(["inferred-context", input]));
		const itemId = await this.update((state) => {
			this.assertOpen();
			const replay = this.replay(state, input.requestId, digest);
			if (replay) return replay;
			const record = this.record(state, input.itemId);
			if (record.item.revision !== input.expectedRevision) throw new DayChanged();
			if (record.sourceDeleted || ["closed", "cancelled"].includes(record.item.phase))
				throw unavailable();
			for (const question of input.questions) {
				const id = `day-context-${sha256(JSON.stringify([input.itemId, record.item.source?.source.revisionId ?? null, question]))}`;
				if (record.item.questions.some((question) => question.id === id)) continue;
				record.item.questions.push({ id, question, answer: null, answeredAt: null });
				record.questionDeliveries.push({
					questionId: id,
					jobId: null,
					decisionId: null,
					origin: "inferred-context",
					presentedAt: null,
					deliveredAt: null,
				});
			}
			record.item.reviewedAt = null;
			record.item.reviewedHeadSha = null;
			for (const reply of record.outbox) if (reply.status !== "delivered") reply.superseded = true;
			this.derivePhase(record);
			this.touch(record);
			this.due(state, record);
			this.remember(state, input.requestId, digest, record.item.id);
			return record.item.id;
		});
		return this.result(input.requestId, itemId);
	}
	/** Main-only until root publishes a shared scheduling operation. Times are actual UTC instants. */
	async scheduleCheck(raw: {
		requestId: string;
		itemId: string;
		expectedRevision: number;
		nextCheckAt: string;
	}): Promise<DayOperationResult> {
		this.assertOpen();
		const input = z
			.strictObject({
				requestId: IdSchema,
				itemId: IdSchema,
				expectedRevision: z.int().positive(),
				nextCheckAt: z.iso.datetime(),
			})
			.parse(raw);
		const digest = sha256(JSON.stringify(["schedule-check", input]));
		const itemId = await this.update((state) => {
			this.assertOpen();
			const replay = this.replay(state, input.requestId, digest);
			if (replay) return replay;
			const record = this.record(state, input.itemId);
			if (record.item.revision !== input.expectedRevision) throw new DayChanged();
			if (["closed", "cancelled"].includes(record.item.phase)) throw unavailable();
			record.item.nextCheckAt = input.nextCheckAt;
			this.touch(record);
			state.supervisor.nextCheckAt = new Date(
				Math.min(Date.parse(state.supervisor.nextCheckAt), Date.parse(input.nextCheckAt))
			).toISOString();
			this.remember(state, input.requestId, digest, record.item.id);
			return record.item.id;
		});
		return this.result(input.requestId, itemId);
	}
	async operate(raw: DayOperateInput): Promise<DayOperationResult> {
		this.assertOpen();
		const input = DayOperateInputSchema.parse(raw);
		const digest = sha256(JSON.stringify(input.operation));
		await this.initialize();
		const replay = this.replay(this.state, input.requestId, digest);
		if (replay) return this.result(input.requestId, replay);
		let clarificationRead: ClarificationRead | undefined;
		if (input.operation.kind === "propose_clarification") {
			const record = this.current(input.operation.itemId);
			if (
				record.item.revision !== input.operation.expectedRevision ||
				!record.item.source ||
				record.sourceDeleted
			)
				throw new DayChanged();
			const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30000)]);
			if (input.operation.kind === "propose_clarification") record.item.clarification = undefined;
			clarificationRead = await this.readClarification(record, signal);
		}
		let ticket: LinearTicket | undefined;
		if (input.operation.kind === "link_linear") {
			const record = this.record(this.state, input.operation.itemId);
			if (record.item.revision !== input.operation.expectedRevision) throw new DayChanged();
			if (!this.ports.linearTicket) throw unavailable();
			const signal = AbortSignal.any([
				this.lifetime.signal,
				AbortSignal.timeout(Math.max(1000, this.ports.operationTimeoutMs ?? 30_000)),
			]);
			ticket = LinearTicketSchema.parse(
				await abortable(this.ports.linearTicket(input.operation.issueId, signal), signal)
			);
			if (ticket.id !== input.operation.issueId) throw unavailable();
		}
		const itemId = await this.update((state) => {
			this.assertOpen();
			const replay = this.replay(state, input.requestId, digest);
			if (replay) return replay;
			const op = input.operation;
			if (op.kind === "capture_manual") {
				const record = this.freshItem({
					title: op.title,
					summary: op.summary,
					kind: op.itemKind,
					source: null,
					requestedById: this.actor.userId,
					accepted: true,
					ownPromise: op.itemKind === "promise",
					repositoryId: null,
				});
				state.records.push(record);
				this.due(state, record);
				this.remember(state, input.requestId, digest, record.item.id);
				return record.item.id;
			}
			const record = this.record(state, op.itemId);
			const item = record.item;
			if (item.revision !== op.expectedRevision) throw new DayChanged();
			if (op.kind === "cover") {
				state.current = state.current.filter((current) => !sameActor(current.actor, this.actor));
				state.current.push({ actor: this.actor, itemId: item.id });
				for (const question of record.questionDeliveries) question.presentedAt ??= this.iso();
			} else {
				if (item.phase === "closed" || item.phase === "cancelled" || record.sourceDeleted)
					throw unavailable();
				switch (op.kind) {
					case "propose_clarification": {
						if (
							!clarificationRead ||
							!item.source ||
							record.outbox.some(
								(r) => r.status === "uncertain" || (r.status !== "delivered" && !r.superseded)
							)
						)
							throw unavailable();
						if (item.clarification?.status === "active")
							throw new Error("Pause or revoke the current delegation first");
						item.clarification = {
							policy: {
								id: this.id(),
								revision: 1,
								connectionId: clarificationRead.connectionId,
								actor: this.actor,
								source: item.source.source,
								originalRequest:
									clarificationRead.messages.find(
										(m) => m.citation.source.messageId === item.source?.source.messageId
									)?.text ?? "",
								scope: op.scope,
								maxMessages: op.maxMessages,
								durationMinutes: op.durationMinutes,
								sendAuthority: "clarification-only-original-thread",
							},
							status: "proposed",
							confirmedAt: null,
							expiresAt: null,
							summary: "",
							missing: [],
							reason: null,
							evidence: clarificationRead.messages,
							attempts: [],
						};
						break;
					}
					case "confirm_clarification": {
						const c = item.clarification;
						if (
							!c ||
							c.status !== "proposed" ||
							c.policy.id !== op.policyId ||
							c.policy.revision !== op.policyRevision ||
							JSON.stringify(c.policy.source) !== JSON.stringify(item.source?.source)
						)
							throw new DayChanged();
						record.clarificationRetryAt = undefined;
						c.status = "active";
						c.confirmedAt = this.iso();
						c.expiresAt = this.iso(c.policy.durationMinutes * 60000);
						break;
					}
					case "pause_clarification":
					case "revoke_clarification": {
						const c = item.clarification;
						if (!c) throw unavailable();
						c.status = op.kind === "pause_clarification" ? "paused" : "revoked";
						c.policy.revision++;
						for (const reply of record.outbox)
							if (reply.clarification && reply.status !== "delivered") reply.superseded = true;
						break;
					}
					case "confirm_local_answer": {
						const job = record.preparation?.job;
						if (
							item.source ||
							item.acceptance !== "accepted" ||
							item.questions.some((question) => question.answer === null) ||
							(item.jobId &&
								(!job ||
									job.state !== "ready" ||
									job.internal?.stage !== "admitted" ||
									!item.reviewedAt ||
									item.reviewedHeadSha !== job.headSha))
						)
							throw unavailable();
						item.localAnswerReceipt = {
							requestId: input.requestId,
							confirmedById: this.actor.userId,
							confirmedAt: this.iso(),
						};
						item.phase = "closed";
						break;
					}
					case "accept":
						item.acceptance = "accepted";
						item.acceptanceBasis = "user_action";
						item.acceptedAt = this.iso();
						break;
					case "decline":
						item.acceptance = "declined";
						item.acceptanceBasis = "none";
						item.acceptedAt = null;
						this.cancelRecord(record, input.requestId);
						break;
					case "cancel":
						this.cancelRecord(record, input.requestId);
						break;
					case "answer_question": {
						const question = item.questions.find((question) => question.id === op.questionId);
						const delivery = record.questionDeliveries.find(
							(delivery) => delivery.questionId === op.questionId
						);
						if (
							!question ||
							!delivery?.presentedAt ||
							state.current.find((current) => sameActor(current.actor, this.actor))?.itemId !==
								item.id ||
							question.answer !== null
						)
							throw unavailable();
						question.answer = op.answer;
						question.answeredAt = this.iso();
						break;
					}
					case "start_work":
						if (
							item.acceptance !== "accepted" ||
							item.questions.some((question) => question.answer === null) ||
							(item.repositoryId && item.repositoryId !== op.repositoryId)
						)
							throw unavailable();
						item.repositoryId = op.repositoryId;
						record.preparation ??= this.preparation(record);
						record.preparation.executionRequested = true;
						record.paused = false;
						break;
					case "pause_work":
					case "resume_work":
						if (op.kind === "resume_work" && item.acceptance !== "accepted") throw unavailable();
						record.paused = op.kind === "pause_work";
						if (item.jobId)
							record.controls.push({
								requestId: `day-control-${sha256(JSON.stringify([this.actor, input.requestId]))}`,
								jobId: item.jobId,
								kind: record.paused ? "pause" : "resume",
								deliveredAt: null,
							});
						break;
					case "mark_reviewed": {
						const job = record.preparation?.job;
						if (
							item.acceptance !== "accepted" ||
							(job
								? job.state !== "ready" ||
									job.internal?.stage !== "admitted" ||
									job.headSha !== op.headSha ||
									!op.headSha
								: op.headSha !== null)
						)
							throw unavailable();
						item.reviewedAt = this.iso();
						item.reviewedHeadSha = op.headSha;
						break;
					}
					case "draft_reply":
						if (item.acceptance !== "accepted" || !item.source) throw unavailable();
						if (
							record.outbox.some(
								(reply) => !reply.clarification && !reply.superseded && reply.status !== "delivered"
							)
						)
							throw new DayChanged();
						item.replyDraft = {
							revision:
								Math.max(
									0,
									item.replyDraft?.revision ?? 0,
									...record.outbox.map((reply) => reply.draftRevision)
								) + 1,
							body: op.body,
						};
						break;
					case "send_reply": {
						if (op.body.length > 4000)
							throw new Error("Slack replies must be at most 4000 characters.");
						if (
							item.acceptance !== "accepted" ||
							!item.source ||
							!item.replyDraft ||
							item.replyDraft.revision !== op.draftRevision ||
							item.replyDraft.body !== op.body ||
							item.questions.some((question) => question.answer === null)
						)
							throw new DayChanged();
						const job = record.preparation?.job;
						if (
							item.jobId &&
							(!job ||
								job.state !== "ready" ||
								!item.reviewedAt ||
								item.reviewedHeadSha !== job.headSha)
						)
							throw unavailable();
						if (
							record.outbox.some(
								(reply) => !reply.clarification && !reply.superseded && reply.status !== "delivered"
							)
						)
							throw new DayChanged();
						record.outbox.push({
							requestId: `day-reply-${sha256(JSON.stringify([this.actor, input.requestId]))}`,
							source: item.source.source,
							body: op.body,
							bodyDigest: sha256(op.body),
							draftRevision: op.draftRevision,
							confirmedAt: this.iso(),
							status: "pending",
							superseded: false,
							attempts: 0,
							lastAttemptAt: null,
							providerKey: null,
							providerBindingDigest: null,
							receipt: null,
						});
						break;
					}
					case "link_linear":
						if (!ticket) throw unavailable();
						record.linear = ticket;
						item.linearIssueId = ticket.id;
						break;
				}
				this.derivePhase(record);
			}
			this.touch(record);
			this.due(state, record);
			this.remember(state, input.requestId, digest, item.id);
			return item.id;
		});
		return this.result(input.requestId, itemId);
	}
	private cancelRecord(record: DayRecord, requestId: string) {
		if (record.item.clarification) {
			record.item.clarification.status = "revoked";
			record.item.clarification.policy.revision++;
		}
		if (record.item.jobId)
			record.controls.push({
				requestId: `day-control-${sha256(JSON.stringify([this.actor, requestId]))}`,
				jobId: record.item.jobId,
				kind: "cancel",
				deliveredAt: null,
			});
		for (const reply of record.outbox) reply.superseded = true;
		record.item.phase = "cancelled";
		record.paused = true;
		record.item.reviewedAt = null;
		record.item.reviewedHeadSha = null;
	}
	private preparation(record: DayRecord): NonNullable<DayRecord["preparation"]> {
		return {
			requestId: `day-prepare-${sha256(JSON.stringify([record.item.id, record.item.source?.source.revisionId ?? null, record.item.repositoryId]))}`,
			sourceRevision: record.item.source?.source.revisionId ?? null,
			job: null,
			executionRequested: false,
			executionDeliveredAt: null,
		};
	}
	private derivePhase(record: DayRecord) {
		const { item } = record;
		if (["closed", "cancelled"].includes(item.phase)) return;
		if (record.paused) {
			item.phase = "captured";
			return;
		}
		if (record.sourceDeleted || item.acceptance === "declined") {
			item.phase = "cancelled";
			return;
		}
		if (
			item.acceptance === "accepted" &&
			record.outbox.some(
				(reply) => !reply.clarification && !reply.superseded && reply.status !== "delivered"
			)
		) {
			item.phase = "awaiting_reply";
			return;
		}
		if (item.questions.some((question) => question.answer === null)) {
			item.phase = "needs_context";
			return;
		}
		const prep = record.preparation;
		const job = prep?.job;
		if (job?.internal?.stage === "prepared" && !prep?.executionDeliveredAt) item.phase = "ready";
		else if (job?.state === "ready" && job.internal?.stage === "admitted")
			item.phase =
				item.acceptance === "accepted"
					? item.reviewedAt && item.reviewedHeadSha === job.headSha
						? "awaiting_reply"
						: "ready_review"
					: "ready";
		else if (
			job?.internal?.stage === "admitted" &&
			["failed", "cancelled", "paused"].includes(job.state)
		)
			item.phase = "captured";
		else if (job?.state === "needs-input") item.phase = "needs_context";
		else if (prep)
			item.phase =
				prep.executionRequested && item.acceptance === "accepted" && !!prep.executionDeliveredAt
					? "working"
					: "preparing";
		else item.phase = "captured";
	}
	private async cycle(signal: AbortSignal) {
		this.ensureAvailable(signal);
		const due = this.state.records
			.filter(
				({ item }) =>
					this.owns(item) && item.nextCheckAt && Date.parse(item.nextCheckAt) <= this.now()
			)
			.slice(0, 20)
			.map(({ item }) => item.id);
		let failed = false;
		for (const id of due) {
			this.ensureAvailable(signal);
			try {
				await this.update((state) => {
					this.ensureAvailable(signal);
					this.record(state, id).checkpoint.lastAttemptAt = this.iso();
				});
				await this.processRecord(id, signal);
				await this.update((state) => {
					this.ensureAvailable(signal);
					const record = this.record(state, id);
					record.checkpoint.lastCompletedAt = this.iso();
					record.checkpoint.failures = 0;
					record.checkpoint.error = null;
					const pending =
						record.controls.some((control) => !control.deliveredAt) ||
						record.outbox.some((reply) => reply.status === "uncertain");
					record.item.nextCheckAt =
						["closed", "cancelled"].includes(record.item.phase) && !pending
							? null
							: this.iso(this.supervisor.cadenceMs);
				});
			} catch (error) {
				if (signal.aborted) throw error;
				this.ensureAvailable(signal);
				failed = true;
				await this.update((state) => {
					this.ensureAvailable(signal);
					const record = this.record(state, id);
					record.checkpoint.failures++;
					record.checkpoint.error = record.outbox.some((reply) => reply.status === "uncertain")
						? "reply_failed"
						: "worker_unavailable";
					record.item.nextCheckAt = this.iso(this.supervisor.backoff(record.checkpoint.failures));
				});
			}
		}
		if (failed) throw new Error("Some work could not be checked. Its checkpoints were retained.");
	}
	private current(id: string) {
		return structuredClone(this.record(this.state, id));
	}
	private async readClarification(
		record: DayRecord,
		signal: AbortSignal
	): Promise<ClarificationRead> {
		const source = record.item.source?.source;
		if (!source || !this.ports.replies?.readClarification) throw unavailable();
		this.ensureAvailable(signal);
		const read = ClarificationReadSchema.parse(
			await abortable(this.ports.replies.readClarification(source, signal), signal)
		);
		this.ensureAvailable(signal);
		const original = read.messages.find((m) => m.citation.source.messageId === source.messageId);
		if (
			!read.complete ||
			!original ||
			original.deletedAt ||
			original.truncated ||
			JSON.stringify(original.citation.source) !== JSON.stringify(source) ||
			original.text !== record.sourceText ||
			read.messages.some(
				(m) =>
					m.deletedAt ||
					m.truncated ||
					m.citation.source.workspaceId !== this.actor.workspaceId ||
					m.citation.source.conversationId !== source.conversationId ||
					(m.citation.source.threadId ?? m.citation.source.messageId) !==
						(source.threadId ?? source.messageId) ||
					!m.citation.audience.readerIds.includes(this.actor.userId)
			) ||
			(record.item.clarification &&
				record.item.clarification.status !== "proposed" &&
				read.connectionId !== record.item.clarification.policy.connectionId)
		)
			throw unavailable();
		return read;
	}
	private async deferClarification(id: string, error: unknown) {
		if (!(error instanceof SlackError) || error.code !== "rate-limited") return false;
		await this.update((state) => {
			this.record(state, id).clarificationRetryAt = this.iso(
				Math.max(1, error.retryAfterSeconds ?? 60) * 1000
			);
		});
		return true;
	}
	private async processClarification(id: string, signal: AbortSignal) {
		const record = this.current(id);
		const c = record.item.clarification;
		if (
			!c ||
			c.status !== "active" ||
			record.paused ||
			["closed", "cancelled"].includes(record.item.phase)
		)
			return;

		const change = async (reason: DayClarification["reason"]) =>
			this.update((state) => {
				const current = this.record(state, id);
				if (
					current.item.clarification?.policy.id !== c.policy.id ||
					current.item.clarification.status !== "active"
				)
					return;
				current.item.clarification.status = "needs_user";
				current.item.clarification.reason = reason;
				for (const reply of current.outbox)
					if (reply.clarification && reply.status !== "delivered") reply.superseded = true;
				this.touch(current);
			});
		if (c.expiresAt && Date.parse(c.expiresAt) <= this.now()) {
			await change("unanswered");
			return;
		}
		if (record.clarificationRetryAt && Date.parse(record.clarificationRetryAt) > this.now()) return;
		if (c.attempts.some((a) => a.status === "uncertain")) {
			await change("uncertain_send");
			return;
		}
		if (c.attempts.some((a) => a.status === "pending")) return;
		try {
			const read = await this.readClarification(record, signal);
			// Only a new/edited requester answer may trigger a follow-up. Our own posts and other bots cannot loop.
			if (
				c.attempts.length &&
				!read.messages.some(
					(m) =>
						m.authorId === record.item.requestedById &&
						m.citation.source.messageId !== c.policy.source.messageId &&
						!c.evidence.some(
							(old) =>
								old.citation.source.messageId === m.citation.source.messageId &&
								old.citation.source.revisionId === m.citation.source.revisionId &&
								old.text === m.text
						)
				)
			)
				return;
			if (!this.ports.analyzeClarification) throw unavailable();
			const analysis = ClarificationAnalysisSchema.parse(
				await abortable(this.ports.analyzeClarification(c, read, signal), signal)
			);
			const fresh = read; // A separate fresh provider read gates the actual send, possibly on a later paced tick.
			await this.update((state) => {
				this.ensureAvailable(signal);
				const current = this.record(state, id);
				const target = current.item.clarification;
				if (
					!target ||
					target.status !== "active" ||
					current.item.revision !== record.item.revision ||
					target.policy.id !== c.policy.id ||
					target.policy.revision !== c.policy.revision
				)
					return;
				target.evidence = fresh.messages;
				target.summary = analysis.summary;
				target.missing = analysis.missing;
				target.reason = analysis.escalation;
				if (analysis.escalation) target.status = "needs_user";
				else if (!analysis.missing.length && !analysis.questions.length) target.status = "complete";
				else if (analysis.questions.length) {
					if (
						target.attempts.length >= target.policy.maxMessages ||
						!target.expiresAt ||
						Date.parse(target.expiresAt) <= this.now()
					) {
						target.status = "needs_user";
						target.reason = "bounds";
					} else {
						const body = analysis.questions.join("\n");
						// Duplicate bodies are never sent even if inference proposes a repeated question.
						if (target.attempts.some((a) => a.bodyDigest === sha256(body))) {
							target.status = "needs_user";
							target.reason = "unanswered";
						} else {
							const requestId = `day-clarify-${sha256(JSON.stringify([this.actor, target.policy.id, target.policy.revision, target.attempts.length]))}`;
							current.outbox.push({
								requestId,
								source: target.policy.source,
								body,
								bodyDigest: sha256(body),
								draftRevision: target.policy.revision,
								confirmedAt: target.confirmedAt ?? this.iso(),
								status: "pending",
								superseded: false,
								attempts: 0,
								lastAttemptAt: null,
								providerKey: null,
								providerBindingDigest: null,
								receipt: null,
								clarification: {
									policyId: target.policy.id,
									policyRevision: target.policy.revision,
									connectionId: target.policy.connectionId,
									threadDigest: clarificationDigest(fresh),
								},
							});
							target.attempts.push({
								requestId,
								policyRevision: target.policy.revision,
								body,
								bodyDigest: sha256(body),
								status: "pending",
								receipt: null,
							});
						}
					}
				}
				this.touch(current);
			});
		} catch (error) {
			if (signal.aborted) throw error;
			if (await this.deferClarification(id, error)) return;
			await change("unavailable");
		}
	}

	private async processRecord(id: string, signal: AbortSignal) {
		await this.processClarification(id, signal);
		let record = this.current(id);
		for (const control of record.controls.filter((control) => !control.deliveredAt)) {
			if (!this.ports.worker) throw unavailable();
			this.ensureAvailable(signal);
			await abortable(
				this.ports.worker.control(control.jobId, control.kind, control.requestId, signal),
				signal
			);
			await this.update((state) => {
				this.ensureAvailable(signal);
				const current = this.record(state, id).controls.find(
					(candidate) => candidate.requestId === control.requestId
				);
				if (current) current.deliveredAt = this.iso();
			});
		}
		record = this.current(id);
		if (
			!record.paused &&
			!record.sourceDeleted &&
			!["closed", "cancelled"].includes(record.item.phase) &&
			record.item.repositoryId
		) {
			if (!this.ports.worker) throw unavailable();
			if (!record.preparation)
				await this.update((state) => {
					this.ensureAvailable(signal);
					const current = this.record(state, id);
					current.preparation ??= this.preparation(current);
					this.derivePhase(current);
					this.touch(current);
				});
			record = this.current(id);
			const preparation = record.preparation;
			const repositoryId = record.item.repositoryId;
			if (!preparation || !repositoryId) throw new DayChanged();
			if (!record.item.jobId) {
				this.ensureAvailable(signal);
				const admitted = z.strictObject({ jobId: IdSchema }).parse(
					await abortable(
						this.ports.worker.prepare(
							{
								requestId: preparation.requestId,
								itemId: id,
								repositoryId,
								source: record.item.source?.source ?? null,
								sourceText: record.sourceText,
								title: record.item.title,
								summary: record.item.summary,
								linear: record.linear,
								policy: "isolated-no-publication",
							},
							signal
						),
						signal
					)
				);
				await this.update((state) => {
					this.ensureAvailable(signal);
					const current = this.record(state, id);
					if (
						current.preparation?.requestId !== preparation.requestId ||
						current.paused ||
						["closed", "cancelled"].includes(current.item.phase)
					) {
						current.controls.push({
							requestId: `day-retire-${sha256(admitted.jobId)}`,
							jobId: admitted.jobId,
							kind: "cancel",
							deliveredAt: null,
						});
						return;
					}
					current.item.jobId = admitted.jobId;
					this.touch(current);
				});
			}
			record = this.current(id);
			if (
				record.preparation?.requestId !== preparation.requestId ||
				!record.item.jobId ||
				record.paused ||
				["closed", "cancelled"].includes(record.item.phase)
			)
				return;
			await this.observe(id, preparation.requestId, signal);
		}
		record = this.current(id);
		for (const delivery of record.questionDeliveries.filter((delivery) => !delivery.deliveredAt)) {
			const question = record.item.questions.find(
				(question) => question.id === delivery.questionId
			);
			if (
				!question?.answer ||
				!this.ports.worker ||
				record.paused ||
				!delivery.jobId ||
				!delivery.decisionId
			)
				continue;
			this.ensureAvailable(signal);
			await abortable(
				this.ports.worker.answer(
					delivery.jobId,
					delivery.decisionId,
					question.answer,
					`day-answer-${sha256(JSON.stringify([id, delivery.questionId, question.answer]))}`,
					signal
				),
				signal
			);
			await this.update((state) => {
				this.ensureAvailable(signal);
				const current = this.record(state, id);
				const target = current.questionDeliveries.find(
					(target) => target.questionId === delivery.questionId
				);
				if (
					target &&
					current.item.questions.find((target) => target.id === delivery.questionId)?.answer ===
						question.answer
				)
					target.deliveredAt = this.iso();
			});
		}
		record = this.current(id);
		const preparation = record.preparation;
		if (
			preparation?.executionRequested &&
			!preparation.executionDeliveredAt &&
			!record.paused &&
			record.item.jobId &&
			record.item.acceptance === "accepted" &&
			!["closed", "cancelled"].includes(record.item.phase) &&
			!record.item.questions.some((question) => question.answer === null) &&
			!record.questionDeliveries.some((delivery) => delivery.jobId && !delivery.deliveredAt)
		) {
			if (!this.ports.worker) throw unavailable();
			this.ensureAvailable(signal);
			await abortable(
				this.ports.worker.execute(record.item.jobId, `${preparation.requestId}-execute`, signal),
				signal
			);
			await this.update((state) => {
				this.ensureAvailable(signal);
				const current = this.record(state, id);
				if (
					current.preparation?.requestId !== preparation.requestId ||
					current.item.acceptance !== "accepted" ||
					current.paused ||
					["closed", "cancelled"].includes(current.item.phase)
				)
					throw new DayChanged();
				current.preparation.executionDeliveredAt = this.iso();
				this.derivePhase(current);
				this.touch(current);
			});
			await this.observe(id, preparation.requestId, signal);
		}
		for (const reply of this.current(id).outbox.filter(
			(reply) => reply.status !== "delivered" && (!reply.superseded || reply.status === "uncertain")
		))
			await this.deliver(id, reply, signal);
	}
	private async observe(id: string, requestId: string, signal: AbortSignal) {
		const before = this.current(id);
		this.ensureAvailable(signal);
		if (!this.ports.worker || !before.item.jobId) throw unavailable();
		const observed = await abortable(this.ports.worker.observe(before.item.jobId, signal), signal);
		if (!observed) throw unavailable();
		const job = WorkJobSchema.parse(observed);
		const internal = job.internal;
		if (
			job.id !== before.item.jobId ||
			job.repositoryId !== before.item.repositoryId ||
			!internal ||
			internal.workspaceId !== this.actor.workspaceId ||
			internal.ownerUserId !== this.actor.userId ||
			internal.itemId !== id ||
			internal.requestId !== requestId ||
			(internal.stage === "admitted" &&
				(!before.preparation?.executionRequested || before.item.acceptance !== "accepted"))
		)
			throw new DayChanged();
		await this.update((state) => {
			this.ensureAvailable(signal);
			const record = this.record(state, id);
			const item = record.item;
			if (record.preparation?.requestId !== requestId || item.jobId !== job.id)
				throw new DayChanged();
			if (record.preparation.job?.headSha !== job.headSha || job.state !== "ready") {
				item.reviewedAt = null;
				item.reviewedHeadSha = null;
				for (const reply of record.outbox)
					if (reply.status !== "delivered") reply.superseded = true;
			}
			record.preparation.job = job;
			if (
				job.state === "ready" &&
				job.internal?.stage === "admitted" &&
				job.reviewedAt &&
				job.headSha &&
				job.checks.every((check) => check.exitCode === 0 && check.commitSha === job.headSha)
			) {
				item.reviewedAt = job.reviewedAt;
				item.reviewedHeadSha = job.headSha;
			}
			for (const decision of job.decisions.filter((decision) => decision.answer === null)) {
				const questionId = `day-question-${sha256(JSON.stringify([job.id, decision.id]))}`;
				if (item.questions.some((question) => question.id === questionId)) continue;
				item.questions.push({
					id: questionId,
					question: decision.question.slice(0, 4000),
					answer: null,
					answeredAt: null,
				});
				record.questionDeliveries.push({
					questionId,
					jobId: job.id,
					decisionId: decision.id,
					origin: "worker-decision",
					presentedAt: null,
					deliveredAt: null,
				});
			}
			this.derivePhase(record);
			this.touch(record);
		});
	}
	private replyEligible(record: DayRecord, reply: DayOutbox) {
		const { item } = record;
		if (reply.clarification) {
			const c = item.clarification;
			return (
				!!c &&
				c.status === "active" &&
				c.confirmedAt !== null &&
				c.expiresAt !== null &&
				Date.parse(c.expiresAt) > this.now() &&
				!reply.superseded &&
				!record.sourceDeleted &&
				!record.paused &&
				!["closed", "cancelled"].includes(item.phase) &&
				c.policy.id === reply.clarification.policyId &&
				c.policy.revision === reply.clarification.policyRevision &&
				c.policy.connectionId === reply.clarification.connectionId &&
				JSON.stringify(c.policy.source) === JSON.stringify(reply.source) &&
				JSON.stringify(item.source?.source) === JSON.stringify(reply.source)
			);
		}
		const job = record.preparation?.job;
		return (
			!reply.superseded &&
			!record.paused &&
			!record.sourceDeleted &&
			item.acceptance === "accepted" &&
			item.source?.source.revisionId === reply.source.revisionId &&
			!["closed", "cancelled"].includes(item.phase) &&
			!item.questions.some((question) => question.answer === null) &&
			(!item.jobId ||
				(!!job &&
					job.state === "ready" &&
					job.internal?.stage === "admitted" &&
					!!item.reviewedAt &&
					item.reviewedHeadSha === job.headSha))
		);
	}
	private ledgerReply(
		state: DayState,
		key: string,
		binding: string
	): { record: DayRecord; reply: DayOutbox } {
		z.string().min(1).max(500).parse(key);
		z.string()
			.regex(/^[a-f0-9]{64}$/)
			.parse(binding);
		for (const record of state.records.filter(({ item }) => this.owns(item))) {
			const reply = record.outbox.find((reply) => key.endsWith(`:${reply.requestId}`));
			if (!reply) continue;
			if (
				binding !== sha256(JSON.stringify([reply.source, reply.body])) ||
				(reply.providerKey && reply.providerKey !== key)
			)
				throw new DayChanged();
			return { record, reply };
		}
		throw unavailable();
	}
	private reserveReply(
		key: string,
		binding: string
	): ReturnType<DayProviderReplyLedger["reserve"]> {
		this.assertOpen();
		return this.update((state) => {
			this.assertOpen();
			const { record, reply } = this.ledgerReply(state, key, binding);
			if (reply.receipt) return { state: "delivered" as const, receipt: reply.receipt };
			if (reply.providerKey) return { state: "uncertain" as const };
			if (reply.clarification && !key.startsWith(`${reply.clarification.connectionId}:`))
				throw new DayChanged();
			if (reply.status !== "uncertain" || !this.replyEligible(record, reply)) throw unavailable();
			reply.providerKey = key;
			reply.providerBindingDigest = binding;
			return { state: "reserved" as const };
		});
	}
	private async providerDelivered(
		key: string,
		binding: string,
		raw: ChatReplyReceipt
	): Promise<void> {
		this.assertOpen();
		const receipt = ChatReplyReceiptSchema.parse(raw);
		await this.update((state) => {
			this.assertOpen();
			const { record, reply } = this.ledgerReply(state, key, binding);
			if (
				reply.providerKey !== key ||
				reply.providerBindingDigest !== binding ||
				!replyMatches(reply, receipt)
			)
				throw new DayChanged();
			if (reply.receipt && JSON.stringify(reply.receipt) !== JSON.stringify(receipt))
				throw new DayChanged();
			this.recordReceipt(record, reply, receipt);
		});
	}
	/** Use only with the mandatory reservation ledger: absence then proves no provider POST was admitted. */
	async reconcileReply(
		raw: DayReplyRequest
	): Promise<
		{ status: "delivered"; receipt: ChatReplyReceipt } | { status: "not_found" | "uncertain" }
	> {
		this.assertOpen();
		const input = z
			.strictObject({
				requestId: IdSchema,
				clarification: z.literal(true).optional(),
				clarificationThreadDigest: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.optional(),
				source: ChatSourceSchema,
				body: z.string().min(1).max(4000),
			})
			.parse(raw);
		await this.initialize();
		const reply = this.state.records
			.filter(({ item }) => this.owns(item))
			.flatMap((record) => record.outbox)
			.find((reply) => reply.requestId === input.requestId);
		if (
			!reply ||
			sha256(JSON.stringify([reply.source, reply.body])) !==
				sha256(JSON.stringify([input.source, input.body]))
		)
			throw new DayChanged();
		if (reply.receipt) return { status: "delivered", receipt: structuredClone(reply.receipt) };
		return { status: reply.providerKey ? "uncertain" : "not_found" };
	}
	private recordReceipt(record: DayRecord, reply: DayOutbox, receipt: ChatReplyReceipt) {
		reply.status = "delivered";
		reply.receipt = receipt;
		if (reply.clarification) {
			const attempt = record.item.clarification?.attempts.find(
				(a) => a.requestId === reply.requestId
			);
			if (attempt) {
				attempt.status = "delivered";
				attempt.receipt = receipt;
			}
			this.touch(record);
			return;
		}
		if (this.replyEligible(record, reply)) {
			record.item.answerReceipt = receipt;
			record.item.phase = "closed";
			record.item.nextCheckAt = null;
			this.touch(record);
		}
	}
	private async deliver(id: string, initial: DayOutbox, signal: AbortSignal) {
		if (!this.ports.replies) throw unavailable();
		const input: DayReplyRequest = {
			requestId: initial.requestId,
			source: initial.source,
			body: initial.body,
			...(initial.clarification
				? {
						clarification: true as const,
						clarificationThreadDigest: initial.clarification.threadDigest,
					}
				: {}),
		};
		this.ensureAvailable(signal);
		if (initial.status === "uncertain") {
			const result = await abortable(this.ports.replies.reconcile(input, signal), signal);
			if (result.status === "delivered") {
				await this.settleReply(id, initial, result.receipt, signal);
				return;
			}
			if (result.status === "uncertain") throw unavailable();
			if (initial.superseded) return;
		}
		if (initial.clarification) {
			const retryAt = this.current(id).clarificationRetryAt;
			if (retryAt && Date.parse(retryAt) > this.now()) return;
			let read: ClarificationRead;
			try {
				read = await this.readClarification(this.current(id), signal);
			} catch (error) {
				if (await this.deferClarification(id, error)) return;
				await this.update((state) => {
					const record = this.record(state, id);
					const reply = record.outbox.find((r) => r.requestId === initial.requestId);
					if (reply) reply.superseded = true;
					if (record.item.clarification?.status === "active") {
						record.item.clarification.status = "needs_user";
						record.item.clarification.reason = "unavailable";
						this.touch(record);
					}
				});
				return;
			}
			if (clarificationDigest(read) !== initial.clarification.threadDigest) {
				await this.update((state) => {
					const record = this.record(state, id);
					const reply = record.outbox.find((r) => r.requestId === initial.requestId);
					if (reply) reply.superseded = true;
					if (record.item.clarification) record.item.clarification.status = "needs_user";
					if (record.item.clarification) record.item.clarification.evidence = read.messages;
					if (record.item.clarification) record.item.clarification.reason = "source_changed";
					this.touch(record);
				});
				return;
			}
		}
		// Mark uncertain before calling the provider. A crash after network acceptance must never resend blindly.
		const admitted = await this.update((state) => {
			this.ensureAvailable(signal);
			const record = this.record(state, id);
			const reply = record.outbox.find((reply) => reply.requestId === initial.requestId);
			if (!reply || !this.replyEligible(record, reply)) return false;
			reply.status = "uncertain";
			reply.attempts++;
			reply.lastAttemptAt = this.iso();
			const attempt = record.item.clarification?.attempts.find(
				(a) => a.requestId === reply.requestId
			);
			if (attempt) attempt.status = "uncertain";
			return true;
		});
		if (!admitted) return;
		this.ensureAvailable(signal);
		const latest = this.current(id);
		const latestReply = latest.outbox.find((reply) => reply.requestId === initial.requestId);
		if (!latestReply || !this.replyEligible(latest, latestReply)) return;
		let receipt: ChatReplyReceipt;
		try {
			receipt = await abortable(this.ports.replies.send(input, signal), signal);
		} catch (error) {
			// The provider ledger may have durably recorded proof before the outer response was lost.
			if (
				this.current(id).outbox.some(
					(reply) => reply.requestId === initial.requestId && reply.receipt
				)
			)
				return;
			throw error;
		}
		await this.settleReply(id, initial, receipt, signal);
	}
	private async settleReply(
		id: string,
		expected: DayOutbox,
		raw: ChatReplyReceipt,
		signal: AbortSignal
	) {
		const receipt = ChatReplyReceiptSchema.parse(raw);
		if (!replyMatches(expected, receipt)) throw new DayChanged();
		await this.update((state) => {
			this.ensureAvailable(signal);
			const record = this.record(state, id);
			const reply = record.outbox.find((reply) => reply.requestId === expected.requestId);
			if (!reply || !replyMatches(reply, receipt)) throw new DayChanged();
			this.recordReceipt(record, reply, receipt);
		});
	}
	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.closing = true;
		this.lifetime.abort();
		this.disposal = (async () => {
			await this.supervisor.dispose();
			await this.writes.catch(() => {});
			this.listeners.clear();
		})();
		return this.disposal;
	}
}
