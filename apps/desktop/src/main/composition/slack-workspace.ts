import { createHash } from "node:crypto";
import { z } from "zod";
import {
	type ChatMessage,
	ChatMessageSchema,
	type ChatSource,
	ChatSourceSchema,
} from "../../shared/contracts/chat";
import { type DayActor, DayActorSchema } from "../../shared/contracts/day";
import type { DayReplyPort, DayService } from "../day/service";
import type { DayAvailability } from "../day/supervisor";
import {
	type SlackClassification,
	SlackClassificationSchema,
	SlackIdentitySchema,
	type SlackLease,
	type SlackPreferences,
	type SlackSourceRecord,
	SlackStoreError,
	type SlackWorkspaceStorePort,
	slackMessageDigest,
	slackSourceKey,
} from "../db/slack-store";
import {
	SlackClient,
	type SlackClientOptions,
	type SlackThreadInput,
	slackDate,
} from "../slack/client";
import { SlackIntake, type SlackPublication } from "../slack/intake";
import { type SlackSocket, SlackSocketMode, type SlackSocketState } from "../slack/socket";
import {
	type SlackCredential,
	SlackCredentialSchema,
	SlackError,
	SlackIdSchema,
	abortable,
	compareTs,
} from "../slack/types";

export interface SlackClassificationInput {
	requestId: string;
	actor: DayActor;
	message: ChatMessage;
}
export interface SlackWorkspaceOptions {
	getCredential(): Promise<SlackCredential | undefined>;
	store: SlackWorkspaceStorePort;
	getDay(): DayService | undefined;
	activateActor(actor: DayActor, replies: DayReplyPort): Promise<void>;
	availability(): DayAvailability;
	/** The model's output is data only. Authority is a different injected, trusted boundary. */
	classify(input: SlackClassificationInput, signal: AbortSignal): Promise<unknown>;
	ownPromiseAuthority?(
		input: SlackClassificationInput & { classification: SlackClassification }
	):
		| Promise<{ explicitOwnPromise: true; actor: DayActor } | undefined>
		| { explicitOwnPromise: true; actor: DayActor }
		| undefined;
	publishKnowledge?(batch: SlackPublication, signal: AbortSignal): Promise<void>;
	/** Root's main-only Day invalidation purges known text and fences old source replays, including closed work. */
	invalidateSource?(
		input: { requestId: string; source: ChatSource; updatedAt: string; deleted?: boolean },
		signal: AbortSignal
	): Promise<unknown>;
	getAppToken?(): Promise<string | undefined>;
	client?: SlackClient;
	clientOptions?: Pick<SlackClientOptions, "fetch" | "historyIntervalMs">;
	socketConnect?: (url: string) => SlackSocket;
	initialWatches?: string[];
	now?: () => number;
	cadenceMs?: number;
}
export interface SlackWorkspaceStatus {
	mode:
		| "stopped"
		| "unconfigured"
		| "connecting"
		| "idle"
		| "watching"
		| "sleeping"
		| "offline"
		| "backoff";
	transport: "poll" | "socket";
	actor: DayActor | null;
	watchCount: number;
	lastSyncAt: string | null;
	error:
		| "connection-required"
		| "access-denied"
		| "missing-scope"
		| "rate-limited"
		| "provider"
		| "store"
		| "classification"
		| "day"
		| "capacity"
		| null;
	retryAt: string | null;
	coverage: {
		history: "watched-only";
		threads: "known-only";
		edits: "bounded-rescan";
		deletions: "socket-events-only" | "not-observable";
		offline: "may-have-gaps";
	};
}
interface Session {
	generation: number;
	lease: SlackLease;
	controller: AbortController;
	intake: SlackIntake;
	socket?: { controller: AbortController; pending: Promise<void> };
	socketAttempted: boolean;
	checkpointSequence: number;
}
const watchSchema = z
	.strictObject({ conversationIds: z.array(SlackIdSchema).max(32) })
	.refine((row) => new Set(row.conversationIds).size === row.conversationIds.length);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameActor = (a: DayActor, b: DayActor) =>
	a.workspaceId === b.workspaceId && a.userId === b.userId;
const actorOf = (lease: SlackLease): DayActor => ({
	workspaceId: lease.workspaceId,
	userId: lease.userId,
});
const identityOf = (value: {
	connectionId: string;
	workspaceId: string;
	userId: string;
	appId: string;
}) =>
	SlackIdentitySchema.parse({
		connectionId: value.connectionId,
		workspaceId: value.workspaceId,
		userId: value.userId,
		appId: value.appId,
	});

/**
 * Main-process service with no renderer/window/foreground-turn ownership or environment access.
 * Root registers SLACK_STORE_MIGRATION_SQL, keeps the app alive and injects actual power/network state.
 * Empty watches never crawl. An injected client must use this service's mandatory Day reply ledger;
 * using the default actual SlackClient wires it automatically. Reconcile never searches Slack text.
 * Full source-text/closed-item invalidation requires root's invalidateSource callback; the fallback
 * only cancels active known work. Knowledge publication admits verified sources, never inferred facts.
 * Priority inference is cached as data; only canonical capture fields and queued review questions are
 * applied to Day here. There is no public priority mutation in the accepted Day base.
 */
export class SlackWorkspaceCoordinator {
	readonly client: SlackClient;
	readonly replyLedger: NonNullable<SlackClientOptions["replyLedger"]>;
	readonly replies: DayReplyPort;
	private readonly now: () => number;
	private readonly cadence: number;
	private started = false;
	private disposed = false;
	private generation = 0;
	private session?: Session;
	private timer?: ReturnType<typeof setTimeout>;
	private cycle?: { controller: AbortController; pending: Promise<void> };
	private preferenceWrites: Promise<unknown> = Promise.resolve();
	private readonly nextMethod = { history: 0, replies: 0 };
	private view: SlackWorkspaceStatus = {
		mode: "stopped",
		transport: "poll",
		actor: null,
		watchCount: 0,
		lastSyncAt: null,
		error: null,
		retryAt: null,
		coverage: {
			history: "watched-only",
			threads: "known-only",
			edits: "bounded-rescan",
			deletions: "not-observable",
			offline: "may-have-gaps",
		},
	};
	constructor(private readonly options: SlackWorkspaceOptions) {
		this.now = options.now ?? Date.now;
		this.cadence = Math.max(1000, options.cadenceMs ?? 5000);
		if (options.initialWatches) watchSchema.parse({ conversationIds: options.initialWatches });
		this.replyLedger = {
			reserve: async (key, binding) => {
				const session = this.required();
				await this.ensure(session);
				if (!key.startsWith(`${session.lease.connectionId}:`))
					throw new SlackError("stale-connection");
				return (await this.day(session)).replyLedger.reserve(key, binding);
			},
			delivered: async (key, binding, receipt) => {
				const session = this.required();
				await this.ensure(session);
				if (!key.startsWith(`${session.lease.connectionId}:`))
					throw new SlackError("stale-connection");
				await (await this.day(session)).replyLedger.delivered(key, binding, receipt);
			},
		};
		this.client =
			options.client ??
			new SlackClient({
				...options.clientOptions,
				getCredential: options.getCredential,
				replyLedger: this.replyLedger,
				now: this.now,
			});
		// Stable across sleep/reconnect: a retained same-actor DayService must not keep a retired session closure.
		this.replies = {
			send: async (input, signal) => {
				const session = this.required();
				await this.ensure(session, signal);
				return this.client.send(input, signal);
			},
			reconcile: async (input, signal) => {
				const session = this.required();
				await this.ensure(session, signal);
				return (await this.day(session)).reconcileReply(input);
			},
		};
	}
	status(): SlackWorkspaceStatus {
		return structuredClone(this.view);
	}
	async watching(): Promise<string[]> {
		const session = this.required();
		return [...(await this.options.store.preferences(session.lease)).conversationIds];
	}
	private required(): Session {
		if (!this.session) throw new SlackError("connection-required");
		return this.session;
	}
	private live(session: Session, signal?: AbortSignal): void {
		const available = this.options.availability();
		if (
			this.disposed ||
			!this.started ||
			this.session !== session ||
			this.generation !== session.generation ||
			session.controller.signal.aborted ||
			signal?.aborted ||
			!available.awake ||
			!available.online
		)
			throw new SlackError("cancelled");
	}
	private async ensure(session: Session, signal?: AbortSignal): Promise<void> {
		this.live(session, signal);
		const bounded = AbortSignal.any([
			session.controller.signal,
			...(signal ? [signal] : []),
			AbortSignal.timeout(30_000),
		]);
		const credential = await this.client.credential(bounded);
		const configured = await abortable(this.options.getCredential(), bounded);
		if (!configured) throw new SlackError("connection-required");
		if (
			JSON.stringify(identityOf(SlackCredentialSchema.parse(configured))) !==
			JSON.stringify(identityOf(credential))
		)
			throw new SlackError("stale-connection");
		if (JSON.stringify(identityOf(credential)) !== JSON.stringify(identityOf(session.lease)))
			throw new SlackError("stale-connection");
		this.live(session, bounded);
		const head = await abortable(this.options.store.head(), bounded);
		if (
			head.epoch !== session.lease.epoch ||
			JSON.stringify(head.identity) !== JSON.stringify(identityOf(session.lease))
		)
			throw new SlackError("stale-connection");
		this.live(session, bounded);
	}
	private async day(session: Session): Promise<DayService> {
		this.live(session);
		const day = this.options.getDay();
		if (!day || !sameActor((await day.snapshot()).actor, actorOf(session.lease)))
			throw new SlackError("stale-connection");
		this.live(session);
		return day;
	}
	private schedule(): void {
		clearTimeout(this.timer);
		if (!this.started || this.disposed) return;
		this.timer = setTimeout(() => void this.tick(), this.cadence);
		this.timer.unref?.();
	}
	async start(): Promise<void> {
		if (this.disposed || this.started) return;
		this.started = true;
		await this.tick();
	}
	async stop(): Promise<void> {
		this.started = false;
		this.generation++;
		clearTimeout(this.timer);
		this.cycle?.controller.abort();
		await this.retire();
		await this.cycle?.pending.catch(() => {});
		this.view = {
			...this.view,
			mode: "stopped",
			actor: null,
			watchCount: 0,
			error: null,
			retryAt: null,
			transport: "poll",
			coverage: { ...this.view.coverage, deletions: "not-observable" },
		};
	}
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.stop();
	}
	async availabilityChanged(): Promise<void> {
		const available = this.options.availability();
		this.generation++;
		this.cycle?.controller.abort();
		await this.retire();
		await this.cycle?.pending.catch(() => {});
		if (!available.awake || !available.online) {
			this.view.mode = available.awake ? "offline" : "sleeping";
		} else if (this.started && !this.disposed) await this.tick();
		this.schedule();
	}
	private async retire(): Promise<void> {
		const session = this.session;
		this.session = undefined;
		this.view.transport = "poll";
		this.view.coverage.deletions = "not-observable";
		if (!session) return;
		session.controller.abort();
		session.socket?.controller.abort();
		await session.socket?.pending.catch(() => {});
		try {
			await this.options.store.release(session.lease);
		} catch {
			/* A newer connection owns its lease. */
		}
	}
	tick(): Promise<void> {
		if (!this.started || this.disposed) return Promise.resolve();
		if (this.cycle) return this.cycle.pending;
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
		const pending = abortable(this.check(signal), signal)
			.catch((error) => {
				if (!controller.signal.aborted && this.started && !this.disposed) this.failed(error);
			})
			.finally(() => {
				if (this.cycle?.pending === pending) this.cycle = undefined;
				this.schedule();
			});
		this.cycle = { controller, pending };
		return pending;
	}
	private failed(error: unknown, fallback: SlackWorkspaceStatus["error"] = "provider") {
		let code = fallback;
		if (error instanceof SlackStoreError) code = "store";
		if (error instanceof SlackError) {
			if (
				[
					"connection-required",
					"access-denied",
					"missing-scope",
					"rate-limited",
					"capacity",
				].includes(error.code)
			)
				code = error.code as SlackWorkspaceStatus["error"];
		}
		this.view.error = code;
		this.view.mode = code === "connection-required" ? "unconfigured" : "backoff";
		if (error instanceof SlackError && error.retryAfterSeconds)
			this.view.retryAt = new Date(this.now() + error.retryAfterSeconds * 1000).toISOString();
	}
	private async connect(signal: AbortSignal): Promise<Session> {
		const configured = await abortable(this.options.getCredential(), signal);
		if (!configured) throw new SlackError("connection-required");
		const credential = await this.client.credential(signal);
		if (
			JSON.stringify(identityOf(SlackCredentialSchema.parse(configured))) !==
			JSON.stringify(identityOf(credential))
		)
			throw new SlackError("stale-connection");
		const identity = identityOf(credential);
		if (
			this.session &&
			JSON.stringify(identityOf(this.session.lease)) === JSON.stringify(identity)
		) {
			await this.ensure(this.session, signal);
			return this.session;
		}
		this.generation++;
		await this.retire();
		this.view.mode = "connecting";
		this.view.actor = null;
		this.view.watchCount = 0;
		this.view.transport = "poll";
		this.view.lastSyncAt = null;
		const generation = this.generation;
		const head = await this.options.store.head();
		const capability = await this.client.capabilities(signal);
		await this.client.assertCurrent(credential, signal);
		if (signal.aborted || !this.started || generation !== this.generation)
			throw new SlackError("cancelled");
		if (capability.workspaceId !== identity.workspaceId || capability.userId !== identity.userId)
			throw new SlackError("access-denied");
		const lease = await this.options.store.activate(identity, head.epoch);
		const controller = new AbortController();
		const session = {
			generation,
			lease,
			controller,
			socketAttempted: false,
			checkpointSequence: 0,
		} as Session;
		session.intake = new SlackIntake({
			client: this.client,
			now: this.now,
			load: async (connectionId) => {
				await this.ensure(session);
				if (connectionId !== lease.connectionId) throw new SlackError("stale-connection");
				const saved = await this.options.store.checkpoint(lease);
				this.live(session);
				session.checkpointSequence = saved?.sequence ?? 0;
				return saved?.data;
			},
			save: async (connectionId, checkpoint) => {
				await this.ensure(session);
				if (connectionId !== lease.connectionId) throw new SlackError("stale-connection");
				await this.options.store.saveCheckpoint(lease, checkpoint, session.checkpointSequence);
				this.live(session);
				session.checkpointSequence++;
				this.view.lastSyncAt = new Date(this.now()).toISOString();
			},
			publish: (batch, inputSignal) => this.publish(session, batch, inputSignal),
		});
		this.session = session;
		try {
			await abortable(this.options.activateActor(actorOf(lease), this.replies), signal);
			await this.day(session);
			await this.ensure(session, signal);
			const preferences = await this.options.store.preferences(lease);
			this.nextMethod.history = preferences.nextHistoryAt;
			this.nextMethod.replies = preferences.nextRepliesAt;
			if (preferences.sequence === 0 && this.options.initialWatches?.length)
				await this.updatePreferences(session, (current) => ({
					...current,
					conversationIds: [...(this.options.initialWatches ?? [])],
				}));
			this.view.actor = actorOf(lease);
			this.view.error = null;
			this.view.retryAt = null;
			if (preferences.rateLimitedUntil > this.now()) {
				this.view.error = "rate-limited";
				this.view.mode = "backoff";
				this.view.retryAt = new Date(preferences.rateLimitedUntil).toISOString();
			}
			return session;
		} catch (error) {
			await this.retire();
			throw error;
		}
	}
	private async check(signal: AbortSignal): Promise<void> {
		const available = this.options.availability();
		if (!available.awake || !available.online) {
			this.view.mode = available.awake ? "offline" : "sleeping";
			return;
		}
		let session: Session;
		try {
			session = await this.connect(signal);
		} catch (error) {
			await this.retire();
			this.view.actor = null;
			this.view.watchCount = 0;
			throw error;
		}
		const preferences = await this.options.store.preferences(session.lease);
		this.live(session, signal);
		this.view.watchCount = preferences.conversationIds.length;
		this.socket(session, preferences);
		if (!preferences.conversationIds.length) {
			this.view.mode = "idle";
			return;
		}
		if (!this.view.retryAt || Date.parse(this.view.retryAt) <= this.now()) {
			this.view.error = null;
			this.view.retryAt = null;
			this.view.mode = "watching";
		}
		try {
			await this.poll(session, preferences, signal);
		} catch (error) {
			this.failed(error);
		}
		try {
			await this.drain(session, signal);
		} catch (error) {
			this.failed(error, "classification");
		}
	}
	private updatePreferences(
		session: Session,
		mutate: (current: SlackPreferences) => SlackPreferences
	): Promise<SlackPreferences> {
		const work = this.preferenceWrites
			.catch(() => {})
			.then(async () => {
				await this.ensure(session);
				const previous = await this.options.store.preferences(session.lease);
				this.live(session);
				const next = { ...mutate(structuredClone(previous)), sequence: previous.sequence + 1 };
				await this.options.store.savePreferences(session.lease, next, previous.sequence);
				this.live(session);
				return next;
			});
		this.preferenceWrites = work;
		return work;
	}
	async watch(input: { conversationIds: string[] }): Promise<SlackWorkspaceStatus> {
		const validated = watchSchema.parse(input);
		this.cycle?.controller.abort();
		const session = this.required();
		await this.ensure(session);
		const next = await this.updatePreferences(session, (current) => ({
			...current,
			conversationIds: [...validated.conversationIds],
			threads: current.threads.filter((t) => validated.conversationIds.includes(t.conversationId)),
			nextStream: 0,
		}));
		session.socket?.controller.abort();
		await session.socket?.pending;
		session.socket = undefined;
		session.socketAttempted = false;
		this.view.watchCount = next.conversationIds.length;
		this.view.mode = next.conversationIds.length ? "watching" : "idle";
		this.socket(session, next);
		return this.status();
	}
	async conversations(input: { cursor?: string; limit?: number } = {}, signal?: AbortSignal) {
		const session = this.required();
		const bounded = AbortSignal.any([
			session.controller.signal,
			...(signal ? [signal] : []),
			AbortSignal.timeout(30000),
		]);
		await this.ensure(session, bounded);
		const result = await this.client.listConversations(input, bounded);
		await this.ensure(session, bounded);
		return result;
	}
	async thread(input: SlackThreadInput, signal?: AbortSignal) {
		const session = this.required();
		const bounded = AbortSignal.any([
			session.controller.signal,
			...(signal ? [signal] : []),
			AbortSignal.timeout(30000),
		]);
		await this.ensure(session, bounded);
		const result = await this.client.thread(input, bounded);
		await this.ensure(session, bounded);
		return result;
	}
	private socket(session: Session, preferences: SlackPreferences): void {
		if (!this.options.getAppToken || !preferences.conversationIds.length || session.socketAttempted)
			return;
		session.socketAttempted = true;
		const controller = new AbortController();
		const signal = AbortSignal.any([session.controller.signal, controller.signal]);
		const socket = new SlackSocketMode({
			client: this.client,
			getAppToken: this.options.getAppToken,
			connect: this.options.socketConnect,
			intake: {
				receive: async (payload, inputSignal) => {
					await this.ensure(session, inputSignal);
					const event = z
						.object({ event: z.object({ channel: SlackIdSchema }) })
						.safeParse(payload);
					if (!event.success) return "ignored";
					const watched = await this.options.store.preferences(session.lease);
					this.live(session, inputSignal);
					if (!watched.conversationIds.includes(event.data.event.channel)) return "ignored";
					return session.intake.receive(payload, inputSignal);
				},
			},
			onState: (state) => this.socketState(session, state),
		});
		const pending = socket.run(signal).catch(() => {
			if (this.session === session) this.failed(new SlackError("provider"));
		});
		session.socket = { controller, pending };
	}
	private socketState(session: Session, state: SlackSocketState): void {
		if (this.session !== session || session.controller.signal.aborted) return;
		this.view.transport = state.mode === "socket" ? "socket" : "poll";
		this.view.coverage.deletions =
			state.mode === "socket" ? "socket-events-only" : "not-observable";
	}
	private async poll(
		session: Session,
		preferences: SlackPreferences,
		signal: AbortSignal
	): Promise<void> {
		const streams = [
			...preferences.conversationIds.map((conversationId) => ({
				conversationId,
				threadTs: undefined as string | undefined,
			})),
			...preferences.threads,
		];
		let selected = -1;
		for (let offset = 0; offset < streams.length; offset++) {
			const index = (preferences.nextStream + offset) % streams.length;
			const stream = streams[index];
			if (stream && this.now() >= this.nextMethod[stream.threadTs ? "replies" : "history"]) {
				selected = index;
				break;
			}
		}
		const stream = streams[selected];
		if (!stream) return;
		const method = stream.threadTs ? "replies" : "history";
		this.nextMethod[method] =
			this.now() + Math.max(1000, this.options.clientOptions?.historyIntervalMs ?? 60_000);
		await this.updatePreferences(session, (current) => ({
			...current,
			nextStream: (selected + 1) % Math.max(1, streams.length),
			nextHistoryAt: this.nextMethod.history,
			nextRepliesAt: this.nextMethod.replies,
		}));
		try {
			// Membership is required for automatic watched polling, including public channels.
			const audience = await this.client.audience(stream.conversationId, signal);
			if (!audience.readerIds.includes(session.lease.userId)) throw new SlackError("access-denied");
			const result = await session.intake.poll(stream, signal);
			this.nextMethod[method] =
				this.now() + Math.max(1000, this.options.clientOptions?.historyIntervalMs ?? 60_000);
			if (result.threadIds.length)
				await this.updatePreferences(session, (current) => {
					const threads = [...current.threads];
					for (const threadTs of result.threadIds)
						if (
							!threads.some(
								(t) => t.conversationId === stream.conversationId && t.threadTs === threadTs
							)
						) {
							if (threads.length >= 96) throw new SlackError("capacity");
							threads.push({ conversationId: stream.conversationId, threadTs });
						}
					return { ...current, threads };
				});
		} catch (error) {
			this.nextMethod[method] =
				this.now() +
				(error instanceof SlackError && error.retryAfterSeconds
					? error.retryAfterSeconds * 1000
					: 60_000);
			if (error instanceof SlackError && error.code === "rate-limited") {
				await this.updatePreferences(session, (current) => ({
					...current,
					rateLimitedUntil: Math.max(current.rateLimitedUntil, this.nextMethod[method]),
				}));
			}
			throw error;
		} finally {
			if (!signal.aborted)
				await this.updatePreferences(session, (current) => ({
					...current,
					nextHistoryAt: this.nextMethod.history,
					nextRepliesAt: this.nextMethod.replies,
				}));
		}
	}
	private async publish(
		session: Session,
		batch: SlackPublication,
		signal: AbortSignal
	): Promise<void> {
		await this.ensure(session, signal);
		if (batch.connectionId !== session.lease.connectionId) throw new SlackError("stale-connection");
		const preferences = await this.options.store.preferences(session.lease);
		for (const raw of batch.messages) {
			const message = ChatMessageSchema.parse(raw);
			if (!preferences.conversationIds.includes(message.citation.source.conversationId)) continue;
			await this.stage(session, message.citation.source, message, !!message.deletedAt, signal);
		}
		for (const raw of batch.deletions) {
			const source = ChatSourceSchema.parse(raw);
			if (!preferences.conversationIds.includes(source.conversationId)) continue;
			const previous = await this.options.store.source(session.lease, source);
			if (!previous?.deleted) await this.stage(session, source, null, true, signal);
		}
	}
	private async stage(
		session: Session,
		source: ChatSource,
		message: ChatMessage | null,
		deleted: boolean,
		signal: AbortSignal
	): Promise<void> {
		await this.ensure(session, signal);
		if (source.workspaceId !== session.lease.workspaceId) throw new SlackError("access-denied");
		const previous = await this.options.store.source(session.lease, source);
		this.live(session, signal);
		if (
			previous?.deleted ||
			(previous && !deleted && compareTs(source.revisionId, previous.source.revisionId) < 0)
		)
			return;
		const digest = message ? slackMessageDigest(message) : hash([source, "deleted"]);
		if (previous && previous.source.revisionId === source.revisionId && !deleted) {
			if (previous.digest !== digest) throw new SlackError("invalid-data");
			let current = previous;
			if (
				message &&
				previous.message &&
				message.citation.audience.membershipRevision !==
					previous.message.citation.audience.membershipRevision
			) {
				current = {
					...previous,
					message,
					sequence: previous.sequence + 1,
					knowledgeApplied: !this.options.publishKnowledge,
				};
				await this.options.store.saveSource(session.lease, current, previous.sequence);
			}
			await this.knowledge(session, current, signal);
			return;
		}
		const record: SlackSourceRecord = {
			sequence: (previous?.sequence ?? 0) + 1,
			source,
			message,
			digest,
			deleted,
			decision: deleted ? { kind: "none" } : null,
			ownPromise: false,
			dayApplied: false,
			knowledgeApplied: !this.options.publishKnowledge,
		};
		await this.options.store.saveSource(session.lease, record, previous?.sequence ?? 0);
		await this.invalidate(session, record, signal);
		await this.knowledge(session, record, signal);
	}
	private async knowledge(
		session: Session,
		record: SlackSourceRecord,
		signal: AbortSignal
	): Promise<SlackSourceRecord | null> {
		if (record.knowledgeApplied || !this.options.publishKnowledge) return record;
		if (!(await this.currentRecord(session, record, signal))) return null;
		await abortable(
			this.options.publishKnowledge(
				{
					connectionId: session.lease.connectionId,
					messages: record.message ? [record.message] : [],
					deletions: record.deleted ? [record.source] : [],
				},
				signal
			),
			signal
		);
		if (!(await this.currentRecord(session, record, signal))) return null;
		const next = { ...record, sequence: record.sequence + 1, knowledgeApplied: true };
		await this.options.store.saveSource(session.lease, next, record.sequence);
		return next;
	}
	private async invalidate(
		session: Session,
		record: SlackSourceRecord,
		signal: AbortSignal
	): Promise<void> {
		await this.ensure(session, signal);
		if (this.options.invalidateSource) {
			await abortable(
				this.options.invalidateSource(
					{
						requestId: `slack-invalidate-${hash([actorOf(session.lease), record.source, record.deleted])}`,
						source: record.source,
						updatedAt: record.message?.updatedAt ?? slackDate(record.source.revisionId),
						deleted: record.deleted,
					},
					signal
				),
				signal
			);
			this.live(session, signal);
			return;
		}
		const day = await this.day(session);
		const snapshot = await day.snapshot();
		this.live(session, signal);
		const item = snapshot.items.find(
			(item) => item.source && slackSourceKey(item.source.source) === slackSourceKey(record.source)
		);
		if (
			item &&
			item.phase !== "closed" &&
			item.phase !== "cancelled" &&
			(record.deleted || item.source?.source.revisionId !== record.source.revisionId)
		) {
			await day.operate({
				requestId: `slack-invalidate-${hash([record.source, item.revision])}`,
				operation: { kind: "cancel", itemId: item.id, expectedRevision: item.revision },
			});
		}
		if (
			record.deleted &&
			record.message &&
			item &&
			item.source?.source.revisionId !== record.source.revisionId
		) {
			await day.capture({
				requestId: `slack-delete-${hash(record.source)}`,
				message: record.message,
				kind: item.kind,
				title: item.title,
				summary: "The source message is no longer available.",
				repositoryId: item.repositoryId,
			});
		}
	}
	private async currentRecord(
		session: Session,
		record: SlackSourceRecord,
		signal: AbortSignal
	): Promise<SlackSourceRecord | null> {
		await this.ensure(session, signal);
		const current = await this.options.store.source(session.lease, record.source);
		this.live(session, signal);
		return current &&
			current.source.revisionId === record.source.revisionId &&
			current.digest === record.digest &&
			current.sequence === record.sequence
			? current
			: null;
	}
	private async drain(session: Session, signal: AbortSignal): Promise<void> {
		const preferences = await this.options.store.preferences(session.lease);
		const rows = await this.options.store.pending(session.lease, 32, preferences.conversationIds);
		let record = rows.find((row) =>
			preferences.conversationIds.includes(row.source.conversationId)
		);
		if (!record) return;
		await this.invalidate(session, record, signal);
		const published = await this.knowledge(session, record, signal);
		if (!published) return;
		record = published;
		if (!record.decision && record.message && !record.deleted) {
			const input: SlackClassificationInput = {
				requestId: `slack-classify-${hash([actorOf(session.lease), record.source, record.digest])}`,
				actor: actorOf(session.lease),
				message: structuredClone(record.message),
			};
			const result = await abortable(this.options.classify(input, signal), signal);
			if (!(await this.currentRecord(session, record, signal))) return;
			const decision = SlackClassificationSchema.parse(result === null ? { kind: "none" } : result);
			const authority = this.options.ownPromiseAuthority
				? await abortable(
						Promise.resolve(
							this.options.ownPromiseAuthority({ ...input, classification: decision })
						),
						signal
					)
				: undefined;
			if (
				authority &&
				(!authority.explicitOwnPromise ||
					!sameActor(DayActorSchema.parse(authority.actor), input.actor) ||
					record.message.authorId !== input.actor.userId ||
					decision.kind !== "promise" ||
					record.message.truncated)
			)
				throw new SlackError("access-denied");
			if (!(await this.currentRecord(session, record, signal))) return;
			const next = { ...record, sequence: record.sequence + 1, decision, ownPromise: !!authority };
			await this.options.store.saveSource(session.lease, next, record.sequence);
			record = next;
		}
		if (!record.dayApplied) {
			if (!(await this.currentRecord(session, record, signal))) return;
			if (record.message && !record.deleted && record.decision && record.decision.kind !== "none") {
				const day = await this.day(session);
				this.live(session, signal);
				const captured = await day.capture(
					{
						requestId: `slack-capture-${hash([actorOf(session.lease), record.source, record.digest])}`,
						message: record.message,
						kind: record.decision.kind,
						title: record.decision.title,
						summary: record.decision.summary,
						repositoryId: record.decision.repositoryId,
					},
					record.ownPromise
						? { explicitOwnPromise: true, actor: actorOf(session.lease) }
						: undefined
				);
				let item = captured.snapshot.items.find((item) => item.id === captured.itemId);
				if (
					item &&
					record.decision.priorityRank !== undefined &&
					record.decision.priorityReason?.trim()
				) {
					if (!(await this.currentRecord(session, record, signal))) return;
					const ranked = await day.setInferredPriority({
						requestId: `slack-priority-${hash([record.source, record.digest])}`,
						itemId: item.id,
						expectedRevision: item.revision,
						sourceRevisionId: record.source.revisionId,
						rank: record.decision.priorityRank,
						reason: record.decision.priorityReason,
					});
					item = ranked.snapshot.items.find((row) => row.id === captured.itemId);
				}
				if (record.decision.questions.length && item && !item.questions.length) {
					if (!(await this.currentRecord(session, record, signal))) return;
					await day.queueContext({
						requestId: `slack-context-${hash([record.source, record.digest])}`,
						itemId: item.id,
						expectedRevision: item.revision,
						questions: record.decision.questions,
					});
				}
			}
			if (!(await this.currentRecord(session, record, signal))) return;
			const next = { ...record, sequence: record.sequence + 1, dayApplied: true };
			await this.options.store.saveSource(session.lease, next, record.sequence);
			record = next;
		}
	}
}
