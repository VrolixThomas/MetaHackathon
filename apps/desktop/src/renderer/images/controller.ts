import {
	type ImageAsset,
	ImageAssetSchema,
	type ImageReadResult,
	ImageReadResultSchema,
} from "../../shared/contracts";

export type ImageReader = (id: string, signal: AbortSignal) => Promise<ImageReadResult>;
export async function loadImageAsset(
	raw: ImageAsset,
	read: ImageReader,
	signal: AbortSignal
): Promise<ImageReadResult> {
	if (signal.aborted) throw new DOMException("Image cancelled", "AbortError");
	const asset = ImageAssetSchema.parse(raw);
	const result = ImageReadResultSchema.parse(await read(asset.id, signal));
	if (signal.aborted) throw new DOMException("Image cancelled", "AbortError");
	if (JSON.stringify(result.asset) !== JSON.stringify(asset))
		throw new Error("Image metadata changed");
	const prefix = `data:${asset.mime};base64,`;
	if (!result.dataUrl.startsWith(prefix)) throw new Error("Image MIME changed");
	const encoded = result.dataUrl.slice(prefix.length);
	if (encoded.length > Math.ceil(asset.byteLength / 3) * 4)
		throw new Error("Image byte count changed");
	const decoded = atob(encoded);
	if (btoa(decoded) !== encoded || decoded.length !== asset.byteLength)
		throw new Error("Image byte count changed");
	const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	if (signal.aborted) throw new DOMException("Image cancelled", "AbortError");
	if (Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !== asset.sha256)
		throw new Error("Image digest changed");
	return result;
}

/** Decoding and natural dimensions are required in addition to committed visible frames. */
export async function waitForImagePresentation(
	image: Pick<
		HTMLImageElement,
		"decode" | "complete" | "naturalWidth" | "naturalHeight" | "getClientRects"
	>,
	asset: ImageAsset,
	signal: AbortSignal,
	frame: () => Promise<void> = () =>
		new Promise((resolve) => requestAnimationFrame(() => resolve())),
	visible: () => boolean = () =>
		document.visibilityState === "visible" && image.getClientRects().length > 0
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort = () => {};
	const stopped = new Promise<never>((_, reject) => {
		abort = () => reject(new Error("Image presentation cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		timer = setTimeout(abort, 8000);
	});
	try {
		if (signal.aborted) return false;
		await Promise.race([image.decode(), stopped]);
		for (let count = 0; count < 2; count++) {
			await Promise.race([frame(), stopped]);
			if (
				signal.aborted ||
				!image.complete ||
				image.naturalWidth !== asset.width ||
				image.naturalHeight !== asset.height ||
				!visible()
			)
				return false;
		}
		return true;
	} catch {
		return false;
	} finally {
		if (timer) clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}
