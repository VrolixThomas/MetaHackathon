import { abortable } from "../agent/cancellation";
import type { DaySupervisorCheckpoint } from "./model";

export interface DayAvailability {
	awake: boolean;
	online: boolean;
}
export interface DaySupervisorPorts {
	read(): Promise<DaySupervisorCheckpoint>;
	update(mutator: (checkpoint: DaySupervisorCheckpoint) => void): Promise<void>;
	cycle(signal: AbortSignal): Promise<void>;
	availability(): DayAvailability;
	now?(): number;
	cadenceMs?: number;
	maxBackoffMs?: number;
	operationTimeoutMs?: number;
}

/** Main-process timer only. Root supplies real power/network signals; no window or foreground turn owns it. */
export class DaySupervisor {
	private readonly now: () => number;
	readonly cadenceMs: number;
	private readonly maxBackoffMs: number;
	private readonly timeoutMs: number;
	private timer?: ReturnType<typeof setTimeout>;
	private active?: AbortController;
	private pending?: Promise<void>;
	private started = false;
	private disposed = false;
	constructor(private readonly ports: DaySupervisorPorts) {
		this.now = ports.now ?? Date.now;
		this.cadenceMs = Math.max(1000, ports.cadenceMs ?? 60_000);
		this.maxBackoffMs = Math.max(this.cadenceMs, ports.maxBackoffMs ?? 30 * 60_000);
		this.timeoutMs = Math.max(1000, ports.operationTimeoutMs ?? 30_000);
	}
	private iso(offset = 0) {
		return new Date(this.now() + offset).toISOString();
	}
	backoff(failures: number) {
		return Math.min(this.maxBackoffMs, this.cadenceMs * 2 ** Math.min(20, failures));
	}
	async start() {
		if (this.disposed || this.started) return;
		this.started = true;
		// Interrupted checks are retried from their durable item/outbox checkpoints, never called complete.
		await this.ports.update((checkpoint) => {
			if (checkpoint.mode === "checking" || checkpoint.mode === "stopped") checkpoint.mode = "idle";
		});
		await this.tick();
	}
	private schedule() {
		clearTimeout(this.timer);
		if (!this.started || this.disposed) return;
		this.timer = setTimeout(() => void this.tick().catch(() => {}), Math.min(1000, this.cadenceMs));
		this.timer.unref?.();
	}
	/** Synchronous abort fences late adapters, including those which ignore AbortSignal. */
	availabilityChanged(): Promise<void> {
		const available = this.ports.availability();
		if (!available.awake || !available.online) this.active?.abort();
		return this.ports
			.update((checkpoint) => {
				if (this.disposed) return;
				if (!available.awake) checkpoint.mode = "sleeping";
				else if (!available.online) checkpoint.mode = "offline";
				else if (checkpoint.mode === "sleeping" || checkpoint.mode === "offline")
					checkpoint.mode = "idle";
			})
			.then(() => {
				this.schedule();
			});
	}
	tick(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.pending) return this.pending;
		const work = this.check().finally(() => {
			if (this.pending === work) this.pending = undefined;
			this.schedule();
		});
		this.pending = work;
		return work;
	}
	private async check() {
		const available = this.ports.availability();
		if (!available.awake || !available.online) {
			await this.availabilityChanged();
			return;
		}
		const checkpoint = await this.ports.read();
		if (this.disposed || Date.parse(checkpoint.nextCheckAt) > this.now()) return;
		const controller = new AbortController();
		this.active = controller;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, this.timeoutMs);
		timer.unref?.();
		try {
			await this.ports.update((current) => {
				this.ensureAvailable(controller.signal);
				current.mode = "checking";
				current.lastStartedAt = this.iso();
			});
			this.ensureAvailable(controller.signal);
			await abortable(this.ports.cycle(controller.signal), controller.signal);
			await this.ports.update((current) => {
				this.ensureAvailable(controller.signal);
				current.mode = "idle";
				current.lastCompletedAt = this.iso();
				current.failures = 0;
				current.nextCheckAt = this.iso(this.cadenceMs);
			});
		} catch (error) {
			if (this.disposed) return;
			const availability = this.ports.availability();
			if (!availability.awake || !availability.online || (controller.signal.aborted && !timedOut)) {
				await this.availabilityChanged();
				return;
			}
			await this.ports.update((current) => {
				current.failures++;
				current.mode = "backoff";
				current.nextCheckAt = this.iso(this.backoff(current.failures));
			});
			throw error;
		} finally {
			clearTimeout(timer);
			if (this.active === controller) this.active = undefined;
		}
	}
	private ensureAvailable(signal: AbortSignal) {
		const availability = this.ports.availability();
		if (this.disposed || !availability.awake || !availability.online)
			throw new Error("Day supervision paused");
		signal.throwIfAborted();
	}
	async dispose() {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.timer);
		this.active?.abort();
		await this.pending?.catch(() => {});
		await this.ports.update((checkpoint) => {
			checkpoint.mode = "stopped";
		});
	}
}
