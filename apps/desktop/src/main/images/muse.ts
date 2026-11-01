import { z } from "zod";
import { abortable, throwIfAborted } from "../agent/cancellation";
import { MAX_IMAGE_BYTES, type Raster, inspectRaster } from "./raster";

export const MUSE_IMAGE_MODEL = "muse-image-1.0";
const endpoint = "https://api.meta.ai/v1/images/generations";
export class ImageError extends Error {
	constructor(
		readonly code:
			| "image-not-configured"
			| "image-generation-failed"
			| "image-result-invalid"
			| "image-unavailable"
			| "image-request-conflict"
			| "image-capacity"
	) {
		super(
			{
				"image-not-configured": "Configure MODEL_API_KEY to generate Muse images.",
				"image-generation-failed": "Image generation did not complete. Try a new request.",
				"image-result-invalid":
					"The image provider did not return a supported bounded raster image.",
				"image-unavailable": "This private image asset is unavailable.",
				"image-request-conflict":
					"This image request was already used or interrupted. Use a new request.",
				"image-capacity": "The private image generation capacity has been reached.",
			}[code]
		);
	}
}
export type ImageProvider = {
	provider: string;
	model: string;
	generate(prompt: string, signal: AbortSignal): Promise<Raster>;
};
const resultSchema = z.object({
	data: z
		.array(
			z.strictObject({
				b64_json: z
					.string()
					.min(4)
					.max(16 * 1024 * 1024),
			})
		)
		.length(1),
	output_format: z.literal("png"),
});
async function boundedJSON(response: Response, signal: AbortSignal) {
	const max = 18 * 1024 * 1024;
	if (Number(response.headers.get("content-length") ?? 0) > max || !response.body) {
		void response.body?.cancel().catch(() => {});
		throw new ImageError("image-result-invalid");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		while (true) {
			const chunk = await abortable(reader.read(), signal);
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > max) throw new ImageError("image-result-invalid");
			chunks.push(chunk.value);
		}
		try {
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
		} catch {
			throw new ImageError("image-result-invalid");
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		void reader.cancel().catch(() => {});
		try {
			reader.releaseLock();
		} catch {
			/* A misbehaving transport must not hold cancellation open. */
		}
	}
}
/** Fixed official endpoint; no arbitrary image download, redirects, fallback key or SDK. */
export function createMuseImageProvider(
	env: Readonly<Record<string, string | undefined>>,
	transport: typeof fetch = fetch
): ImageProvider {
	const key = env["MODEL_API_KEY"]?.trim();
	return {
		provider: "meta",
		model: MUSE_IMAGE_MODEL,
		async generate(prompt, signal) {
			throwIfAborted(signal);
			if (!key || key.length > 4096) throw new ImageError("image-not-configured");
			if (!prompt.trim() || prompt.length > 12000) throw new ImageError("image-result-invalid");
			const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
			try {
				const response = await abortable(
					transport(endpoint, {
						method: "POST",
						redirect: "error",
						signal: boundedSignal,
						headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
						body: JSON.stringify({
							model: MUSE_IMAGE_MODEL,
							prompt,
							n: 1,
							response_format: "b64_json",
							output_format: "png",
						}),
					}),
					boundedSignal
				);
				if (!response.ok) {
					void response.body?.cancel().catch(() => {});
					throw new ImageError("image-generation-failed");
				}
				const result = resultSchema.safeParse(await boundedJSON(response, boundedSignal));
				if (!result.success) throw new ImageError("image-result-invalid");
				const data = result.data.data[0]?.b64_json;
				if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
					throw new ImageError("image-result-invalid");
				const bytes = Buffer.from(data, "base64");
				if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== data)
					throw new ImageError("image-result-invalid");
				throwIfAborted(boundedSignal);
				try {
					return inspectRaster(bytes, "image/png");
				} catch {
					throw new ImageError("image-result-invalid");
				}
			} catch (error) {
				throwIfAborted(signal);
				if (error instanceof ImageError) throw error;
				throw new ImageError("image-generation-failed");
			}
		},
	};
}
