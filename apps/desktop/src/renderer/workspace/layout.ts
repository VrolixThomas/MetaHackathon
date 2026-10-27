import type { BrowserBounds } from "../../shared/contracts";

export function splitLimits(width: number) {
	const min = width > 0 ? Math.min(40, (320 / width) * 100) : 30;
	return { min, max: 100 - min - (width > 0 ? (6 / width) * 100 : 0) };
}
export function clampSplit(value: number, width: number) {
	const { min, max } = splitLimits(width);
	return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 55));
}
export function contentBounds(box: BrowserBounds, visible: boolean): BrowserBounds | null {
	if (!visible || box.width < 1 || box.height < 1) return null;
	return {
		x: Math.round(box.x),
		y: Math.round(box.y),
		width: Math.floor(box.width),
		height: Math.floor(box.height),
	};
}
/** A late resize cannot overtake a hide; repeated identical reports do not flood IPC. */
export function createSurfacePresenter(send: (bounds: BrowserBounds | null) => Promise<void>) {
	let pending = Promise.resolve();
	let last: string | undefined;
	return (bounds: BrowserBounds | null) => {
		const key = JSON.stringify(bounds);
		if (key === last) return pending;
		last = key;
		pending = pending
			.catch(() => {})
			.then(() => send(bounds))
			.catch((error) => {
				if (last === key) last = undefined;
				throw error;
			});
		return pending;
	};
}
