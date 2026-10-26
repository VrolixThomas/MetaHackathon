import { type Preview, type PreviewMarker, PreviewSchema } from "../../../shared/contracts";

export type PreviewMode = Preview["viewport"]["mode"];
export type ScrollOffset = { x: number; y: number };

const MAX_VIEWPORT = 8192;
const MAX_DOCUMENT = 32768;

/** A rendering boundary, including bounded geometry and an isolated live origin. */
export function validatePreview(value: unknown, rendererOrigin?: string): Preview {
	const preview = PreviewSchema.parse(value);
	if (preview.evidence.kind === "execution" && preview.evidence.exitCode !== 0) {
		throw new Error("The preview runner did not finish successfully");
	}
	if (preview.viewport.width > MAX_VIEWPORT || preview.viewport.height > MAX_VIEWPORT) {
		throw new Error("Preview viewport exceeds the supported size");
	}
	if (
		preview.markers.some(
			({ bounds }) =>
				bounds.x + bounds.width > MAX_DOCUMENT || bounds.y + bounds.height > MAX_DOCUMENT
		)
	) {
		throw new Error("Preview marker is outside the supported document size");
	}
	if (
		preview.evidence.kind === "execution" &&
		rendererOrigin &&
		new URL(preview.url).origin === rendererOrigin
	) {
		throw new Error("Live previews must use a separate origin from the review workspace");
	}
	return preview;
}

export function previewScale(
	viewport: Preview["viewport"],
	availableWidth: number,
	actualSize: boolean
) {
	if (actualSize) return 1;
	return Math.min(1, Math.max(100, availableWidth) / viewport.width, 480 / viewport.height);
}

export function fixtureDocumentHeight(preview: Preview) {
	return Math.max(
		preview.viewport.height,
		...preview.markers.map(({ bounds }) => bounds.y + bounds.height + 32)
	);
}

export function markerVisibility(
	marker: PreviewMarker,
	viewport: Preview["viewport"],
	scroll: ScrollOffset
) {
	const { x, y, width, height } = marker.bounds;
	if (x + width <= scroll.x || x >= scroll.x + viewport.width) return "outside";
	if (y + height <= scroll.y) return "above";
	if (y >= scroll.y + viewport.height) return "below";
	return "visible";
}

export function scrollToMarker(
	marker: PreviewMarker,
	viewport: Preview["viewport"],
	documentHeight: number
) {
	return Math.max(
		0,
		Math.min(documentHeight - viewport.height, marker.bounds.y - viewport.height / 3)
	);
}

/** Local layout variants retain fixture provenance and every source location. */
export function fixtureViewport(preview: Preview, mode: PreviewMode): Preview {
	if (preview.evidence.kind !== "fixture")
		throw new Error("Live preview geometry requires runtime measurement");
	if (preview.viewport.mode === mode) return preview;
	const phone = mode === "phone";
	return validatePreview({
		...preview,
		viewport: { mode, width: phone ? 390 : 1280, height: phone ? 844 : 800 },
		markers: preview.markers.map((marker) => {
			if (marker.id === "cap-note")
				return {
					...marker,
					label: phone ? "40% cap note wraps on a phone" : "40% cap note fits on one line",
					bounds: phone
						? { x: 24, y: 280, width: 240, height: 48 }
						: { x: 440, y: 240, width: 400, height: 28 },
				};
			if (marker.id === "pay")
				return {
					...marker,
					label: phone ? "Pay is below the fold" : "Pay is visible in the desktop viewport",
					bounds: phone
						? { x: 24, y: 900, width: 342, height: 48 }
						: { x: 440, y: 430, width: 400, height: 48 },
				};
			return marker;
		}),
	});
}

export function validateViewportResult(
	previous: Preview,
	result: unknown,
	mode: PreviewMode,
	rendererOrigin?: string
) {
	const next = validatePreview(result, rendererOrigin);
	if (
		next.prId !== previous.prId ||
		next.commitSha !== previous.commitSha ||
		next.revision !== previous.revision ||
		next.viewport.mode !== mode ||
		next.evidence.kind !== "execution"
	) {
		throw new Error("The refreshed preview does not match this review and viewport");
	}
	return next;
}
