import { z } from "zod";
import { abortable, throwIfAborted } from "../agent/cancellation";
import { MAX_IMAGE_BYTES, type Raster, inspectRaster } from "./raster";

export const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
const endpoint = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_IMAGE_MODEL}:generateContent`;
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
				"image-not-configured":
					"Configure IMAGE_PROVIDER=gemini and GEMINI_API_KEY to generate images.",
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
	candidates: z
		.array(
			z.object({
				finishReason: z.string().optional(),
				content: z
					.object({
						parts: z
							.array(
								z.object({
									thought: z.boolean().optional(),
									inlineData: z
										.object({
											mimeType: z.enum(["image/png", "image/jpeg"]),
											data: z.string().max(16 * 1024 * 1024),
										})
										.optional(),
								})
							)
							.max(32),
					})
					.optional(),
			})
		)
		.max(1)
		.optional(),
});
async function boundedJSON(response: Response, signal: AbortSignal) {
	const max = 18 * 1024 * 1024;
	if (Number(response.headers.get("content-length") ?? 0) > max || !response.body)
		throw new ImageError("image-result-invalid");
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
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
/** Fixed official endpoint; no arbitrary image download, redirects, fallback key or SDK. */
export function createGeminiImageProvider(
	env: Readonly<Record<string, string | undefined>>,
	transport: typeof fetch = fetch
): ImageProvider {
	const provider = env["IMAGE_PROVIDER"];
	const key = env["GEMINI_API_KEY"]?.trim();
	return {
		provider: "gemini",
		model: GEMINI_IMAGE_MODEL,
		async generate(prompt, signal) {
			throwIfAborted(signal);
			if (provider !== "gemini" || !key || key.length > 4096)
				throw new ImageError("image-not-configured");
			if (!prompt.trim() || prompt.length > 12000) throw new ImageError("image-result-invalid");
			const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
			try {
				const response = await abortable(
					transport(endpoint, {
						method: "POST",
						redirect: "error",
						signal: boundedSignal,
						headers: { "Content-Type": "application/json", "x-goog-api-key": key },
						body: JSON.stringify({
							contents: [{ role: "user", parts: [{ text: prompt }] }],
							generationConfig: { responseModalities: ["TEXT", "IMAGE"], candidateCount: 1 },
						}),
					}),
					boundedSignal
				);
				if (!response.ok) {
					await response.body?.cancel().catch(() => {});
					throw new ImageError("image-generation-failed");
				}
				const result = resultSchema.parse(await boundedJSON(response, boundedSignal));
				const candidate = result.candidates?.[0];
				if (candidate?.finishReason && candidate.finishReason !== "STOP")
					throw new ImageError("image-result-invalid");
				const images =
					candidate?.content?.parts.filter((part) => part.inlineData && !part.thought) ?? [];
				if (images.length !== 1) throw new ImageError("image-result-invalid");
				const image = images[0]?.inlineData;
				if (
					!image ||
					!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)
				)
					throw new ImageError("image-result-invalid");
				const bytes = Buffer.from(image.data, "base64");
				if (
					!bytes.length ||
					bytes.length > MAX_IMAGE_BYTES ||
					bytes.toString("base64") !== image.data
				)
					throw new ImageError("image-result-invalid");
				throwIfAborted(boundedSignal);
				return inspectRaster(bytes, image.mimeType);
			} catch (error) {
				throwIfAborted(signal);
				if (error instanceof ImageError) throw error;
				throw new ImageError("image-generation-failed");
			}
		},
	};
}
