import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { captures } from "./captures";
import { chapters, initialStory, storyReducer } from "./story";

test("all six chapters map to full-resolution native app captures", () => {
	for (const chapter of chapters) {
		const capture = captures[chapter.id];
		const bytes = readFileSync(new URL(`../../public${capture.src}`, import.meta.url));
		assert.equal(bytes.readUInt16BE(0), 0xffd8);
		assert(bytes.length > 100000);
		assert(capture.alt.length > 40);
	}
});
test("gallery navigation loops without changing the paused motion preference", () => {
	let state = storyReducer(initialStory, { type: "motion" });
	const visited = [];
	for (let i = 0; i < 6; i++) {
		visited.push(state.chapter);
		state = storyReducer(state, { type: "next" });
	}
	assert.deepEqual(
		visited,
		chapters.map((c) => c.id)
	);
	assert.equal(state.chapter, "plan");
	assert.equal(state.paused, true);
});
test("capture descriptions retain draft and prepared-data boundaries", () => {
	assert.match(captures.follow.alt, /unchecked/);
	assert.match(captures.clarify.caption, /awaiting inspection and authorization/);
	assert.match(captures.fix.caption, /actual local check/);
});
