export function aborted(): Error {
	return new DOMException("Voice operation cancelled", "AbortError");
}

/** Bounds waiting even when an injected transport ignores AbortSignal. */
export function bounded<T>(
	promise: Promise<T>,
	signal: AbortSignal,
	timeoutMs: number,
	timeoutError: Error = new Error("Voice operation timed out")
): Promise<T> {
	return new Promise((resolve, reject) => {
		const finish = (operation: () => void) => {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			operation();
		};
		const cancel = () => finish(() => reject(aborted()));
		const timer = setTimeout(() => finish(() => reject(timeoutError)), timeoutMs);
		// Always attach rejection handlers, including when already cancelled.
		promise.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error))
		);
		if (signal.aborted) return cancel();
		signal.addEventListener("abort", cancel, { once: true });
	});
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(aborted());
		const cancel = () => {
			clearTimeout(timer);
			reject(aborted());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", cancel);
			resolve();
		}, ms);
		signal.addEventListener("abort", cancel, { once: true });
	});
}

export function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
