export const EDGE_MAX_RUN_MS = 100_000;
export interface EdgePorts {
	fetch?: typeof fetch;
	/** Runtime shutdown, independent of the caller disconnecting. */
	signal?: AbortSignal;
	/** May shorten the production budget; never extends it. */
	maxRunMs?: number;
}
export type EdgeHandler = (request: Request) => Promise<Response>;

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
	return secureResponse(Response.json(body, { status, headers }));
}
export function secureResponse(response: Response): Response {
	response.headers.set("Cache-Control", "no-store");
	response.headers.set("X-Content-Type-Options", "nosniff");
	return response;
}

/** Only a complete, known function segment is removed. No decoded/suffix matching. */
export function functionPath(request: Request, name: string): string {
	const path = new URL(request.url).pathname;
	for (const prefix of [`/functions/v1/${name}`, `/${name}`]) {
		if (path === prefix) return "/";
		if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
	}
	return path;
}

export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) {
			reject(signal.reason);
			// The caller already created the operation: still observe a late rejection.
			void pending.catch(() => {});
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Bounds response time even if a controlled transport ignores AbortSignal. */
export async function withinDeadline(
	request: Request,
	ports: EdgePorts,
	run: (signal: AbortSignal, maxRunMs: number) => Promise<Response>
): Promise<Response> {
	const maxRunMs = ports.maxRunMs ?? EDGE_MAX_RUN_MS;
	if (!Number.isInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > EDGE_MAX_RUN_MS)
		return json({ error: "configuration", invalid: ["maxRunMs"] }, 503);
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error("deadline")), maxRunMs);
	const signal = AbortSignal.any([
		request.signal,
		deadline.signal,
		...(ports.signal ? [ports.signal] : []),
	]);
	try {
		signal.throwIfAborted();
		const pending = Promise.resolve().then(() => {
			signal.throwIfAborted();
			return run(signal, maxRunMs);
		});
		const response = await abortable(pending, signal);
		signal.throwIfAborted();
		return secureResponse(response);
	} catch {
		return deadline.signal.aborted
			? json({ error: "deadline", recovery: "durable-lease-expiry" }, 504)
			: json({ error: signal.aborted ? "interrupted" : "unavailable" }, 503);
	} finally {
		clearTimeout(timer);
	}
}

/** Fences every fetch, including older service methods without an explicit caller-signal port. */
export function scopedFetch(signal: AbortSignal, transport: typeof fetch = fetch): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		signal.throwIfAborted();
		const combined = AbortSignal.any([
			signal,
			...(input instanceof Request ? [input.signal] : []),
			...(init?.signal ? [init.signal] : []),
		]);
		combined.throwIfAborted();
		const pending = transport(input, { ...init, signal: combined });
		let response: Response;
		try {
			response = await abortable(pending, combined);
			combined.throwIfAborted();
		} catch (error) {
			void pending.then((late) => late.body?.cancel()).catch(() => {});
			throw error;
		}
		if (!response.body) return response;
		return new Response(abortableBody(response.body, combined), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}) as typeof fetch;
}

export function scopedRequest(request: Request, signal: AbortSignal, path?: string): Request {
	const url = new URL(request.url);
	if (path !== undefined) url.pathname = path;
	const init: RequestInit & { duplex?: "half" } = {
		method: request.method,
		headers: request.headers,
		signal,
		...(request.body ? { body: abortableBody(request.body, signal), duplex: "half" } : {}),
	};
	return new Request(url, init);
}

function abortableBody(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
	const reader = body.getReader();
	let cleanup = () => {};
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const abort = () => {
				controller.error(signal.reason);
				void reader.cancel().catch(() => {});
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
			cleanup = () => signal.removeEventListener("abort", abort);
		},
		async pull(controller) {
			try {
				const result = await abortable(reader.read(), signal);
				if (result.done) {
					cleanup();
					controller.close();
				} else controller.enqueue(result.value);
			} catch (error) {
				cleanup();
				controller.error(error);
			}
		},
		cancel(reason) {
			cleanup();
			void reader.cancel(reason).catch(() => {});
		},
	});
}

export async function smallJson(request: Request, signal: AbortSignal): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) throw new Error("body");
	let text = "";
	let size = 0;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	try {
		while (true) {
			const { value, done } = await abortable(reader.read(), signal);
			if (done) break;
			size += value.byteLength;
			if (size > 1024) throw new Error("body-limit");
			text += decoder.decode(value, { stream: true });
		}
		return JSON.parse(text + decoder.decode());
	} finally {
		void reader.cancel().catch(() => {});
	}
}
