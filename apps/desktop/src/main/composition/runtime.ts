import { type RuntimeOptions, RuntimeService } from "../runtime/service";
import type { ArtifactCatalog } from "./catalog";
import type { MainJobs } from "./jobs";

/** Use this as the application's single RuntimeService; all existing runtime routes still work. */
export class CatalogRuntimeService extends RuntimeService {
	private readonly catalogOperations = new Map<
		string,
		{ controller: AbortController; done: Promise<unknown> }
	>();
	private catalogClosed = false;
	private catalogDisposal?: Promise<void>;
	constructor(
		options: RuntimeOptions,
		private readonly catalog: ArtifactCatalog,
		private readonly jobs: MainJobs
	) {
		super(options);
	}

	private capture<T>(requestId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.catalogClosed || this.catalogOperations.has(requestId))
			return Promise.reject(new Error("Runtime request unavailable or already running"));
		const controller = new AbortController();
		const done = this.jobs
			.run(async (signal) => {
				const cancel = () => super.cancel(requestId);
				signal.addEventListener("abort", cancel, { once: true });
				try {
					return await work(signal);
				} finally {
					signal.removeEventListener("abort", cancel);
				}
			}, controller.signal)
			.finally(() => this.catalogOperations.delete(requestId));
		this.catalogOperations.set(requestId, { controller, done });
		return done;
	}

	override runScenario(requestId: string, prId: string, scenarioId: string) {
		return this.capture(requestId, async (signal) => {
			const result = await super.runScenario(requestId, prId, scenarioId);
			signal.throwIfAborted();
			await this.catalog.saveScenario(result.trace, signal);
			return result;
		});
	}

	override startPreview(requestId: string, prId: string, mode: "phone" | "desktop") {
		return this.capture(requestId, async (signal) => {
			const preview = await super.startPreview(requestId, prId, mode);
			try {
				signal.throwIfAborted();
				return await this.catalog.savePreview(preview, signal);
			} catch (error) {
				await super.stopPreview(preview.id);
				throw error;
			}
		});
	}

	override async stopPreview(id: string) {
		this.catalog.removePreview(id);
		await super.stopPreview(id);
	}

	override cancel(requestId: string) {
		const operation = this.catalogOperations.get(requestId);
		operation?.controller.abort();
		return { cancelled: super.cancel(requestId).cancelled || Boolean(operation) };
	}

	override dispose(): Promise<void> {
		this.catalogDisposal ??= this.disposeCatalogRuntime();
		return this.catalogDisposal;
	}
	private async disposeCatalogRuntime() {
		this.catalogClosed = true;
		for (const id of this.catalogOperations.keys()) this.cancel(id);
		await Promise.allSettled([...this.catalogOperations.values()].map((entry) => entry.done));
		this.catalog.clear();
		await super.dispose();
	}
}
