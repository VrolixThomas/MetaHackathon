import assert from "node:assert/strict";
import { it } from "node:test";
import type { BrowserBounds } from "../../shared/contracts";
import { clampSplit, contentBounds, createSurfacePresenter, splitLimits } from "./layout";

it("keeps both panes reachable by mouse and keyboard at supported widths", () => {
	for (const width of [800, 1080, 1600]) {
		const { min, max } = splitLimits(width);
		assert.equal(clampSplit(-20, width), min);
		assert.equal(clampSplit(150, width), max);
		assert.equal(clampSplit(55, width), 55);
		assert.ok((width * min) / 100 >= 320 - 0.001);
		assert.ok((width * (100 - max)) / 100 - 6 >= 320 - 0.001);
	}
});
it("uses only explicit visibility and actual geometry for the native content bounds", () => {
	const box = { x: 600.2, y: 100.8, width: 400.9, height: 650.4 };
	assert.deepEqual(contentBounds(box, true), { x: 600, y: 101, width: 400, height: 650 });
	assert.equal(contentBounds(box, false), null);
	assert.equal(contentBounds({ ...box, height: 0 }, true), null);
});
it("serializes resize/hide reports and deduplicates unchanged layout", async () => {
	const calls: Array<BrowserBounds | null> = [];
	let release = () => {};
	const present = createSurfacePresenter(async (bounds) => {
		calls.push(bounds);
		if (bounds)
			await new Promise<void>((resolve) => {
				release = resolve;
			});
	});
	const box = { x: 600, y: 100, width: 400, height: 650 };
	const first = present(box);
	assert.equal(present({ ...box }), first);
	await Promise.resolve();
	await Promise.resolve();
	const hidden = present(null);
	assert.deepEqual(calls, [box]);
	release();
	await Promise.all([first, hidden]);
	assert.deepEqual(calls, [box, null]);
});
