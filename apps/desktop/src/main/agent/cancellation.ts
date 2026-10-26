export function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new DOMException("Operation cancelled", "AbortError");
}

/** Also bounds adapters that fail to observe the signal. Late results are discarded. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	// The caller has already started operation. Observe rejection even when cancellation
	// won before entry, otherwise an adapter can trigger an unhandled rejection.
	if (signal.aborted) void operation.catch(() => {});
	throwIfAborted(signal);
	let onAbort: () => void = () => {};
	const cancelled = new Promise<never>((_, reject) => {
		onAbort = () => reject(new DOMException("Operation cancelled", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		const result = await Promise.race([operation, cancelled]);
		throwIfAborted(signal);
		return result;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
