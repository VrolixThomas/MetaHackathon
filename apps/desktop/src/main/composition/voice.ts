import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	type TurnIdentity,
	TurnIdentitySchema,
	type VoiceDiagnostic,
	type VoiceSetupInput,
	VoiceSetupInputSchema,
	type VoiceSetupStatus,
	VoiceSetupStatusSchema,
} from "../../shared/contracts";
import { publicProcedure, router } from "../trpc";
import { VoiceDiagnosticError, voiceDiagnosticMessage } from "../voice/diagnostics";
import {
	type SpeakInput,
	SpeakSchema,
	VoiceAnswerSchema,
	type VoiceOffer,
	VoiceOfferSchema,
	type VoicePoll,
	VoicePollResultSchema,
	VoicePollSchema,
} from "../voice/protocol";
import { VoiceService } from "../voice/service";
import { type SidecarOptions, type VoiceBackend, VoiceSidecar } from "../voice/sidecar";

type Credentials = { meta?: string; elevenlabs?: string };
export interface PreparedVoiceBackend extends VoiceBackend {
	prepare(): Promise<void>;
}
export interface VoiceCompositionOptions {
	getCredentials(): Promise<Credentials>;
	getDataDirectory(): string;
	/** Trusted paths selected by main, never supplied over IPC. */
	command: string;
	args?: string[];
	executableAvailable(): boolean | Promise<boolean>;
	/** Root may read an environment default; persisted configuration takes precedence. */
	defaultVoiceId?: string;
	/** V1 public voice selection lives in the same .env as credentials. */
	getVoiceId?: () => Promise<string | undefined>;
	setVoiceId?: (voiceId: string) => Promise<void>;
	createSidecar?: (options: SidecarOptions) => PreparedVoiceBackend;
	/** Main-only bound from provisional admission, never from connection readiness. */
	preparedLeaseMs?: number;
	/** Monotonic main clock; injectable for lease-boundary tests. */
	now?: () => number;
}

interface ActiveVoice {
	error?: string;
	voiceId: string;
	backend: PreparedVoiceBackend;
	service: VoiceService;
	credentials: Credentials;
	phase: "preparing" | "ready" | "error";
	stopped: boolean;
	warmup?: Promise<void>;
	pending: Map<Promise<unknown>, TurnIdentity>;
}
interface ProvisionalVoice {
	identity: TurnIdentity;
	active: ActiveVoice;
	phase: "offering" | "ready" | "activated" | "retired";
	deadline: number;
	timer?: ReturnType<typeof setTimeout>;
}
const setupError = "Voice setup failed. Check settings and prepare voice again.";
const requestError = "Voice request failed. Prepare voice and try again.";
const sameTurn = (a: TurnIdentity, b: TurnIdentity) =>
	a.sessionId === b.sessionId && a.turnId === b.turnId && a.generation === b.generation;
const sameCredentials = (a: Credentials, b: Credentials) =>
	a.meta === b.meta && a.elevenlabs === b.elevenlabs;
const transientPreparationFailure = (diagnostic?: Readonly<VoiceDiagnostic>) =>
	diagnostic &&
	(diagnostic.stage === "media" || diagnostic.stage === "meta") &&
	["network", "timeout", "unavailable"].includes(diagnostic.code) &&
	(diagnostic.httpStatus === undefined ||
		diagnostic.httpStatus === 408 ||
		diagnostic.httpStatus >= 500);

/** Main-only owner. Setup serializes configuration, while local warmup and media remain cancellable. */
export class VoiceCompositionManager {
	private voiceId: string | null = null;
	private loaded = false;
	private stopped = false;
	private active?: ActiveVoice;
	private queue: Promise<unknown> = Promise.resolve();
	private jobs = new Set<Promise<unknown>>();
	private disposal?: Promise<void>;
	private provisional?: ProvisionalVoice;
	private readonly preparedLeaseMs: number;
	// Keep admission tombstones across sidecar replacement, not just within a VoiceService.
	private turns = new Map<string, { identity: TurnIdentity; cancelled: boolean }>();
	private snapshot: VoiceSetupStatus = { phase: "unconfigured", voiceId: null, missing: [] };

	constructor(private options: VoiceCompositionOptions) {
		const lease = options.preparedLeaseMs ?? 20_000;
		if (!Number.isInteger(lease) || lease < 1 || lease > 20_000)
			throw new Error("Prepared voice lease must be between 1 and 20000 milliseconds");
		this.preparedLeaseMs = lease;
	}

	private now() {
		const value = (this.options.now ?? (() => performance.now()))();
		if (!Number.isFinite(value) || value < 0) throw new Error(requestError);
		return value;
	}
	private currentTurn(active: ActiveVoice, identity: TurnIdentity) {
		const turn = this.turns.get(identity.sessionId);
		return (
			!this.stopped &&
			this.active === active &&
			!active.stopped &&
			turn &&
			!turn.cancelled &&
			sameTurn(turn.identity, identity)
		);
	}
	private clearProvisional(candidate: ProvisionalVoice) {
		if (candidate.phase === "activated" || candidate.phase === "retired") return;
		candidate.phase = "retired";
		clearTimeout(candidate.timer);
		candidate.timer = undefined;
		if (this.provisional === candidate) this.provisional = undefined;
		const turn = this.turns.get(candidate.identity.sessionId);
		if (turn && sameTurn(turn.identity, candidate.identity)) turn.cancelled = true;
	}
	private retireProvisional(candidate: ProvisionalVoice) {
		if (candidate.phase === "activated" || candidate.phase === "retired") return;
		this.clearProvisional(candidate);
		// VoiceService owns abort, high-water admission and compensating late-offer cleanup.
		void this.pending(
			candidate.active,
			candidate.identity,
			candidate.active.service.cancel(candidate.identity)
		).catch(() => {});
	}
	private quietProvisionalFailure(
		active: ActiveVoice,
		identity: TurnIdentity,
		path: string,
		diagnostic?: Readonly<VoiceDiagnostic>
	) {
		const candidate = this.provisional;
		if (
			!candidate ||
			candidate.active !== active ||
			!this.currentTurn(active, identity) ||
			!sameTurn(candidate.identity, identity) ||
			(candidate.phase !== "offering" && candidate.phase !== "ready") ||
			(path !== "offer" && path !== "poll") ||
			!transientPreparationFailure(diagnostic)
		)
			return false;
		this.retireProvisional(candidate);
		return true;
	}

	private assertLive() {
		if (this.stopped) throw new Error("Voice composition is shut down");
	}
	private track<T>(job: Promise<T>): Promise<T> {
		this.jobs.add(job);
		void job.finally(() => this.jobs.delete(job)).catch(() => {});
		return job;
	}
	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const job = this.queue.then(() => {
			this.assertLive();
			return work();
		});
		this.queue = job.catch(() => {});
		return this.track(job);
	}
	private settingsPath() {
		return join(this.options.getDataDirectory(), "voice", "settings.json");
	}
	private load() {
		if (this.loaded) return;
		try {
			this.voiceId = VoiceSetupInputSchema.parse(
				JSON.parse(readFileSync(this.settingsPath(), "utf8"))
			).voiceId;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			const fallback = VoiceSetupInputSchema.safeParse({ voiceId: this.options.defaultVoiceId });
			this.voiceId = fallback.success ? fallback.data.voiceId : null;
		}
		this.loaded = true;
	}
	private publish(
		phase: VoiceSetupStatus["phase"],
		missing: VoiceSetupStatus["missing"] = [],
		error?: string
	) {
		this.snapshot = VoiceSetupStatusSchema.parse({
			phase,
			voiceId: this.voiceId,
			missing,
			...(error ? { error } : {}),
		});
		return structuredClone(this.snapshot);
	}
	private async inspect() {
		if (this.options.getVoiceId) {
			const voiceId = await this.options.getVoiceId();
			this.voiceId = voiceId ? VoiceSetupInputSchema.parse({ voiceId }).voiceId : null;
		} else this.load();
		const [raw, executable] = await Promise.all([
			this.track(Promise.resolve().then(() => this.options.getCredentials())),
			this.track(Promise.resolve().then(() => this.options.executableAvailable())),
		]);
		this.assertLive();
		const credentials: Credentials = {
			meta: raw.meta?.trim() ? raw.meta : undefined,
			elevenlabs: raw.elevenlabs?.trim() ? raw.elevenlabs : undefined,
		};
		const missing: VoiceSetupStatus["missing"] = [];
		if (!credentials.meta) missing.push("meta");
		if (!credentials.elevenlabs) missing.push("elevenlabs");
		if (!this.voiceId) missing.push("voiceId");
		if (!executable) missing.push("executable");
		const active = this.active;
		const phase = missing.length
			? "unconfigured"
			: active &&
					active.voiceId === this.voiceId &&
					sameCredentials(active.credentials, credentials)
				? active.phase
				: "stopped";
		if ((phase === "stopped" || phase === "unconfigured") && this.provisional)
			this.retireProvisional(this.provisional);
		return {
			credentials,
			status: this.publish(
				phase,
				missing,
				phase === "error" ? (active?.error ?? setupError) : undefined
			),
		};
	}
	status(): Promise<VoiceSetupStatus> {
		return this.serialize(async () => {
			try {
				return (await this.inspect()).status;
			} catch {
				this.assertLive();
				return this.publish("error", [], setupError);
			}
		});
	}
	configure(raw: VoiceSetupInput): Promise<VoiceSetupStatus> {
		if (this.provisional) this.retireProvisional(this.provisional);
		return this.serialize(async () => {
			const input = VoiceSetupInputSchema.parse(raw);
			try {
				await this.retire();
				this.assertLive();
				if (this.options.setVoiceId) await this.options.setVoiceId(input.voiceId);
				else {
					const path = this.settingsPath();
					mkdirSync(join(this.options.getDataDirectory(), "voice"), {
						recursive: true,
						mode: 0o700,
					});
					try {
						writeFileSync(`${path}.tmp`, `${JSON.stringify(input)}\n`, { mode: 0o600 });
						renameSync(`${path}.tmp`, path);
					} finally {
						rmSync(`${path}.tmp`, { force: true });
					}
				}
				this.voiceId = input.voiceId;
				this.loaded = true;
				return (await this.inspect()).status;
			} catch {
				this.assertLive();
				return this.publish("error", [], setupError);
			}
		});
	}
	/** Returns while warmup is pending. Poll status; only ready admits an offer. */
	prepare(): Promise<VoiceSetupStatus> {
		return this.serialize(async () => {
			try {
				const { credentials, status } = await this.inspect();
				if (status.phase === "ready" || status.phase === "preparing") return status;
				await this.retire();
				this.assertLive();
				if (status.missing.length) return this.publish("unconfigured", status.missing);
				const voiceId = this.voiceId as string;
				const backend = (this.options.createSidecar ?? ((options) => new VoiceSidecar(options)))({
					command: this.options.command,
					args: this.options.args ? [...this.options.args] : undefined,
					getCredentials: async () => ({ ...credentials, voiceId }),
				});
				const active: ActiveVoice = {
					voiceId,
					backend,
					credentials,
					phase: "preparing",
					stopped: false,
					pending: new Map(),
					service: new VoiceService({
						request: (path, body, signal) => this.request(active, path, body, signal),
						dispose: () => backend.dispose(),
					}),
				};
				this.active = active;
				active.warmup = this.track(
					Promise.resolve()
						.then(() => {
							if (!active.stopped) return backend.prepare();
						})
						.then(
							() => {
								if (this.active === active && !this.stopped) {
									active.phase = "ready";
									this.publish("ready");
								}
							},
							() => {
								if (this.active === active && !this.stopped) {
									active.phase = "error";
									this.publish("error", [], setupError);
								}
							}
						)
				);
				return this.publish("preparing");
			} catch {
				this.assertLive();
				await this.retire().catch(() => {});
				this.assertLive();
				return this.publish("error", [], setupError);
			}
		});
	}
	private pending<T>(active: ActiveVoice, identity: TurnIdentity, job: Promise<T>) {
		active.pending.set(job, identity);
		void job.finally(() => active.pending.delete(job)).catch(() => {});
		return this.track(job);
	}
	private request(active: ActiveVoice, path: string, body: unknown, signal?: AbortSignal) {
		// VoiceService builds these bodies from validated protocol inputs.
		const identity = body as TurnIdentity;
		return this.pending(
			active,
			identity,
			Promise.resolve().then(async () => {
				if (active.stopped) throw new Error(requestError);
				try {
					const result = await active.backend.request(path, body, signal);
					if (path === "offer") return VoiceAnswerSchema.parse(result);
					if (path === "poll") {
						const parsed = VoicePollResultSchema.parse(result);
						let sequence = VoicePollSchema.parse(body).afterSequence;
						for (const event of parsed.events) {
							if (!sameTurn(event, identity) || event.sequence <= sequence)
								throw new VoiceDiagnosticError({ stage: "media", code: "protocol" });
							sequence = event.sequence;
						}
						for (const event of parsed.events) {
							if (event.kind === "error") {
								event.message = event.diagnostic
									? voiceDiagnosticMessage(event.diagnostic)
									: requestError;
							}
						}
						const candidate = this.provisional;
						const errors = parsed.events.filter((event) => event.kind === "error");
						// Inspect the entire batch before retiring: a transient error cannot hide
						// a following authentication/configuration/protocol failure in that batch.
						const failure =
							candidate?.active === active && sameTurn(candidate.identity, identity)
								? (errors.find((event) => !transientPreparationFailure(event.diagnostic)) ??
									errors[0])
								: errors[0];
						if (
							failure &&
							!signal?.aborted &&
							this.currentTurn(active, identity) &&
							!this.quietProvisionalFailure(active, identity, path, failure.diagnostic)
						) {
							active.error ??= failure.message;
							active.phase = "error";
						}
						if (
							!errors.length &&
							candidate?.active === active &&
							sameTurn(candidate.identity, identity) &&
							parsed.events.some((event) => event.kind === "transcript" && event.final)
						)
							this.retireProvisional(candidate);
						return parsed;
					}
					return result;
				} catch (error) {
					if (
						!signal?.aborted &&
						this.currentTurn(active, identity) &&
						!this.quietProvisionalFailure(
							active,
							identity,
							path,
							error instanceof VoiceDiagnosticError ? error.diagnostic : undefined
						)
					) {
						active.phase = "error";
						active.error ??= error instanceof VoiceDiagnosticError ? error.message : requestError;
					}
					if (error instanceof VoiceDiagnosticError) throw error;
					throw new Error(requestError);
				}
			})
		);
	}
	private run<T>(
		identity: TurnIdentity,
		work: (service: VoiceService, active: ActiveVoice) => Promise<T>
	): Promise<T> {
		try {
			this.assertLive();
			const active = this.active;
			if (!active || active.phase !== "ready" || this.snapshot.phase !== "ready")
				throw new Error(requestError);
			return this.pending(
				active,
				identity,
				Promise.resolve()
					.then(async () => {
						if (
							active.stopped ||
							this.active !== active ||
							active.phase !== "ready" ||
							this.snapshot.phase !== "ready"
						)
							throw new Error(requestError);
						const result = await work(active.service, active);
						if (active.stopped || this.active !== active) throw new Error(requestError);
						return result;
					})
					.catch((error: unknown) => {
						if (error instanceof VoiceDiagnosticError) throw error;
						throw new Error(requestError);
					})
			);
		} catch {
			return Promise.reject(new Error(requestError));
		}
	}
	offer(raw: VoiceOffer) {
		const input = VoiceOfferSchema.parse(raw);
		return this.run(input, (service) => {
			if (this.provisional && sameTurn(this.provisional.identity, input))
				throw new Error(requestError);
			this.admit(input);
			if (this.provisional) this.retireProvisional(this.provisional);
			return service.offer(input);
		});
	}
	private admit(input: TurnIdentity, fresh = false) {
		const previous = this.turns.get(input.sessionId);
		if (
			previous &&
			(input.generation < previous.identity.generation ||
				(input.generation === previous.identity.generation &&
					(fresh || previous.cancelled || !sameTurn(input, previous.identity))))
		)
			throw new Error(requestError);
		if (!previous && this.turns.size >= 128) throw new Error(requestError);
		const { sessionId, turnId, generation } = input;
		this.turns.set(sessionId, { identity: { sessionId, turnId, generation }, cancelled: false });
	}
	offerPrepared(raw: VoiceOffer) {
		const input = VoiceOfferSchema.parse(raw);
		return this.run(input, async (service, active) => {
			let candidate = this.provisional;
			if (!candidate || candidate.active !== active || !sameTurn(candidate.identity, input)) {
				const deadline = this.now() + this.preparedLeaseMs;
				this.admit(input, true);
				if (candidate) this.retireProvisional(candidate);
				const { sessionId, turnId, generation } = input;
				candidate = {
					identity: { sessionId, turnId, generation },
					active,
					phase: "offering",
					deadline,
				};
				this.provisional = candidate;
				const registered = candidate;
				candidate.timer = setTimeout(
					() => this.retireProvisional(registered),
					this.preparedLeaseMs
				);
				candidate.timer.unref();
			}
			if (this.now() >= candidate.deadline) {
				this.retireProvisional(candidate);
				throw new Error(requestError);
			}
			const answer = await service.offer(input);
			if (
				this.provisional !== candidate ||
				!this.currentTurn(active, input) ||
				this.now() >= candidate.deadline
			) {
				this.retireProvisional(candidate);
				throw new Error(requestError);
			}
			candidate.phase = "ready";
			return answer;
		});
	}
	activatePrepared(raw: TurnIdentity) {
		const input = TurnIdentitySchema.parse(raw);
		return this.run(input, async (_service, active) => {
			const candidate = this.provisional;
			if (
				!candidate ||
				candidate.active !== active ||
				!sameTurn(candidate.identity, input) ||
				!this.currentTurn(active, input) ||
				candidate.phase !== "ready"
			)
				throw new Error(requestError);
			if (this.now() >= candidate.deadline) {
				this.retireProvisional(candidate);
				throw new Error(requestError);
			}
			candidate.phase = "activated";
			clearTimeout(candidate.timer);
			candidate.timer = undefined;
			this.provisional = undefined;
			return { ok: true as const };
		});
	}
	private requireActivated(input: TurnIdentity) {
		if (this.provisional && sameTurn(this.provisional.identity, input))
			throw new Error(requestError);
	}
	release(raw: TurnIdentity) {
		const input = TurnIdentitySchema.parse(raw);
		return this.run(input, (service) => {
			this.requireActivated(input);
			return service.release(input);
		});
	}
	speak(raw: SpeakInput) {
		const input = SpeakSchema.parse(raw);
		return this.run(input, (service) => {
			this.requireActivated(input);
			return service.speak(input);
		});
	}
	poll(raw: VoicePoll) {
		const input = VoicePollSchema.parse(raw);
		return this.run(input, (service) => service.poll(input));
	}
	cancel(raw: TurnIdentity): Promise<void> {
		const input = TurnIdentitySchema.parse(raw);
		return this.track(
			(async () => {
				try {
					this.assertLive();
					const previous = this.turns.get(input.sessionId);
					if (
						previous &&
						(input.generation < previous.identity.generation ||
							(input.generation === previous.identity.generation &&
								!sameTurn(input, previous.identity)))
					)
						return;
					if (!previous && this.turns.size >= 128) throw new Error(requestError);
					this.turns.set(input.sessionId, { identity: input, cancelled: true });
					if (this.provisional && sameTurn(this.provisional.identity, input))
						this.clearProvisional(this.provisional);
					const active = this.active;
					if (!active) return;
					try {
						// This RPC aborts VoiceService work; aborting renderer transport alone cannot do that.
						await active.service.cancel(input);
					} finally {
						await this.drain(active, input);
					}
				} catch {
					throw new Error(requestError);
				}
			})()
		);
	}
	private async drain(active: ActiveVoice, identity?: TurnIdentity) {
		for (;;) {
			const jobs = [...active.pending]
				.filter(
					([, turn]) =>
						!identity ||
						(turn.sessionId === identity.sessionId &&
							(turn.generation < identity.generation || sameTurn(turn, identity)))
				)
				.map(([job]) => job);
			if (!jobs.length) return;
			await Promise.allSettled(jobs);
		}
	}
	private async retire() {
		const active = this.active;
		if (this.provisional) this.clearProvisional(this.provisional);
		this.active = undefined;
		if (!active) return;
		active.stopped = true;
		for (const turn of this.turns.values()) turn.cancelled = true;
		// Dispose synchronously aborts every service session before waiting for the child or callers.
		try {
			await active.service.dispose();
		} finally {
			await active.warmup;
			await this.drain(active);
		}
	}
	dispose(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.stopped = true;
		this.publish("stopped");
		const retirement = this.retire();
		this.disposal = (async () => {
			const result = await Promise.allSettled([retirement]);
			while (this.jobs.size) await Promise.allSettled([...this.jobs]);
			this.turns.clear();
			if (result[0]?.status === "rejected") throw new Error("Voice shutdown failed");
		})();
		return this.disposal;
	}
}

export function createVoiceComposition(options: VoiceCompositionOptions) {
	return new VoiceCompositionManager(options);
}

/** Root owns registration under voice and calls manager.dispose() before credential shutdown. */
export function createConfiguredVoiceRouter(
	manager: VoiceCompositionManager | (() => VoiceCompositionManager)
) {
	const getManager = () => {
		try {
			return typeof manager === "function" ? manager() : manager;
		} catch {
			throw new Error("Voice service is unavailable");
		}
	};
	return router({
		status: publicProcedure.output(VoiceSetupStatusSchema).query(() => getManager().status()),
		configure: publicProcedure
			.input(VoiceSetupInputSchema)
			.output(VoiceSetupStatusSchema)
			.mutation(({ input }) => getManager().configure(input)),
		prepare: publicProcedure.output(VoiceSetupStatusSchema).mutation(() => getManager().prepare()),
		offer: publicProcedure
			.input(VoiceOfferSchema)
			.output(VoiceAnswerSchema)
			.mutation(({ input }) => getManager().offer(input)),
		offerPrepared: publicProcedure
			.input(VoiceOfferSchema)
			.output(VoiceAnswerSchema)
			.mutation(({ input }) => getManager().offerPrepared(input)),
		activatePrepared: publicProcedure
			.input(TurnIdentitySchema)
			.output(z.strictObject({ ok: z.literal(true) }))
			.mutation(({ input }) => getManager().activatePrepared(input)),
		release: publicProcedure
			.input(TurnIdentitySchema)
			.mutation(({ input }) => getManager().release(input)),
		speak: publicProcedure.input(SpeakSchema).mutation(({ input }) => getManager().speak(input)),
		cancel: publicProcedure
			.input(TurnIdentitySchema)
			.mutation(({ input }) => getManager().cancel(input)),
		poll: publicProcedure
			.input(VoicePollSchema)
			.output(VoicePollResultSchema)
			.query(({ input }) => getManager().poll(input)),
	});
}
