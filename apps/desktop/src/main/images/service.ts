import { createHash } from "node:crypto";
import {
	type GenerateImageInput,
	GenerateImageInputSchema,
	IdSchema,
	type ImageAsset,
} from "../../shared/contracts";
import { abortable, throwIfAborted } from "../agent/cancellation";
import { ImageError, type ImageProvider } from "./muse";
import type { PrivateImageStore } from "./store";

/** Foreground cancellation owns generation only; no voice cancellation touches workers. */
export class ImageService {
	private readonly requests = new Map<
		string,
		{ fingerprint: string; abort: AbortController; result: Promise<ImageAsset> }
	>();
	private readonly cancelled = new Set<string>();
	private disposed = false;
	private running = 0;
	constructor(
		private readonly provider: ImageProvider,
		private readonly store: PrivateImageStore
	) {}
	generate(raw: GenerateImageInput, signal: AbortSignal): Promise<ImageAsset> {
		throwIfAborted(signal);
		if (this.disposed) throw new ImageError("image-unavailable");
		const input = GenerateImageInputSchema.parse(raw);
		if (this.cancelled.has(input.requestId))
			return Promise.reject(new DOMException("Image generation cancelled", "AbortError"));
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify({
					title: input.title,
					prompt: input.prompt,
					provider: this.provider.provider,
					model: this.provider.model,
				})
			)
			.digest("hex");
		const previous = this.requests.get(input.requestId);
		if (previous && previous.fingerprint !== fingerprint)
			throw new ImageError("image-request-conflict");
		if (previous)
			return abortable(
				previous.result.then((asset) => structuredClone(asset)),
				signal
			);
		if (this.requests.size >= 256 || this.running >= 2) throw new ImageError("image-capacity");
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		signal.addEventListener("abort", onAbort, { once: true });
		this.running++;
		const result = Promise.resolve()
			.then(async () => {
				throwIfAborted(abort.signal);
				const stored = await this.store.admit(input.requestId, fingerprint, abort.signal);
				if (stored) return stored;
				try {
					const raster = await abortable(
						this.provider.generate(input.prompt, abort.signal),
						abort.signal
					);
					throwIfAborted(abort.signal);
					return await this.store.save(
						{ ...input, fingerprint, provider: this.provider.provider, model: this.provider.model },
						raster,
						abort.signal
					);
				} catch (error) {
					await this.store.fail(input.requestId, fingerprint);
					throw error;
				}
			})
			.catch((error) => {
				throwIfAborted(abort.signal);
				throw error instanceof ImageError ? error : new ImageError("image-generation-failed");
			})
			.finally(() => {
				this.running--;
				signal.removeEventListener("abort", onAbort);
			});
		this.requests.set(input.requestId, { fingerprint, abort, result });
		return abortable(
			result.then((asset) => structuredClone(asset)),
			signal
		);
	}
	read(id: string, signal?: AbortSignal) {
		if (this.disposed) throw new ImageError("image-unavailable");
		return this.store.read(IdSchema.max(200).parse(id), signal);
	}
	cancel(requestId: string) {
		const id = IdSchema.max(200).parse(requestId);
		if (this.cancelled.size >= 256 && !this.cancelled.has(id)) {
			this.dispose();
			return;
		}
		this.cancelled.add(id);
		this.requests.get(id)?.abort.abort();
	}
	dispose() {
		this.disposed = true;
		for (const request of this.requests.values()) request.abort.abort();
	}
}
