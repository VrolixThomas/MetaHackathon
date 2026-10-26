/** Tracks underlying work, even when an agent caller stops awaiting an abortable port. */
export class MainJobs {
	private readonly shutdown = new AbortController();
	private readonly pending = new Set<Promise<unknown>>();

	run<T>(work: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
		if (this.shutdown.signal.aborted) return Promise.reject(new Error("Composition has shut down"));
		const signal = caller ? AbortSignal.any([caller, this.shutdown.signal]) : this.shutdown.signal;
		const job = Promise.resolve().then(async () => {
			signal.throwIfAborted();
			const result = await work(signal);
			signal.throwIfAborted();
			return result;
		});
		this.pending.add(job);
		void job.finally(() => this.pending.delete(job)).catch(() => {});
		return job;
	}

	stop(): void {
		this.shutdown.abort();
	}

	async drain(): Promise<void> {
		while (this.pending.size) await Promise.allSettled([...this.pending]);
	}
}
