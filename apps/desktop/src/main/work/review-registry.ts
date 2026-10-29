import type { WatchedRepository } from "../../shared/contracts";
import type { ReviewCoordinator } from "../composition/reviews";

/** Each repository keeps its own preparation queue/cache. Selecting one never clears another. */
export class ReviewRegistry {
	private readonly coordinators = new Map<string, ReviewCoordinator>();
	private readonly registrations = new Map<string, WatchedRepository>();
	private active: ReviewCoordinator;
	constructor(
		private readonly legacy: ReviewCoordinator,
		private readonly create: (repository: WatchedRepository) => ReviewCoordinator
	) {
		this.active = legacy;
	}
	register(repository: WatchedRepository, useLegacy = false) {
		const key = repository.repository.toLowerCase();
		this.registrations.set(key, repository);
		if (useLegacy) this.coordinators.set(key, this.legacy);
	}
	getActive() {
		return this.active;
	}
	async ensure(repository: WatchedRepository) {
		this.register(repository);
		const key = repository.repository.toLowerCase();
		let coordinator = this.coordinators.get(key);
		if (!coordinator) {
			coordinator = this.create(repository);
			this.coordinators.set(key, coordinator);
		}
		await coordinator.initialize();
		return coordinator;
	}
	async activate(prId: string, signal: AbortSignal) {
		signal.throwIfAborted();
		const repository = /^([^#]+)#[1-9][0-9]*$/.exec(prId)?.[1];
		if (!repository) throw new Error("Choose an actual GitHub pull request.");
		const current = await this.active.inbox();
		if (current.repository?.toLowerCase() === repository.toLowerCase()) return;
		const registration = this.registrations.get(repository.toLowerCase());
		if (!registration) throw new Error("Add this repository before opening its review.");
		const next = await this.ensure(registration);
		await next.getReady(prId, signal);
		signal.throwIfAborted();
		this.active = next;
	}
	async remove(repository: string) {
		const key = repository.toLowerCase();
		this.registrations.delete(key);
		const coordinator = this.coordinators.get(key);
		if (coordinator && coordinator !== this.active) {
			this.coordinators.delete(key);
			await coordinator.dispose();
		}
	}
	async dispose() {
		await Promise.allSettled(
			[...new Set([...this.coordinators.values(), this.legacy])].map((coordinator) =>
				coordinator.dispose()
			)
		);
		this.coordinators.clear();
		this.registrations.clear();
	}
}
