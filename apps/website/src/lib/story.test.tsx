import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StoryProvider } from "../components/story/context";
import {
	ClarifyView,
	FixView,
	FlowView,
	FollowView,
	PlanView,
	ReviewView,
} from "../components/story/views";
import { type StoryState, chapters, initialStory, reviewFiles, storyReducer } from "./story";

function render(View: ComponentType, state: StoryState = initialStory) {
	return renderToStaticMarkup(
		<StoryProvider initialState={state}>
			<View />
		</StoryProvider>
	);
}

test("one day has six intentional focus changes; nothing advances on its own", () => {
	let state = { ...initialStory };
	assert.equal(state.chapter, "plan");
	assert.equal(state.planScope, null);
	assert.equal(state.follow, "notify");
	const visited = [];
	for (let index = 0; index < 6; index++) {
		visited.push(state.chapter);
		state = storyReducer(state, { type: "next" });
	}
	assert.deepEqual(
		visited,
		chapters.map((c) => c.id)
	);
	assert.equal(state.chapter, "plan");
});

test("planning choices stay with the story while reviews and context remain distinct", () => {
	let state = storyReducer(initialStory, { type: "scope", scope: "layout" });
	assert.match(render(PlanView, state), /Remember files, review position and the pane layout/);
	state = storyReducer(state, { type: "next" });
	state = storyReducer(state, { type: "discussion", open: true });
	assert.equal(state.chapter, "review");
	assert.match(render(ReviewView, state), /How does this fit the bigger ticket/);
	state = storyReducer(state, { type: "file", file: 2 });
	assert.equal(state.discussion, false);
	assert.equal(state.planScope, "layout");
	assert.match(render(ReviewView, state), /Finish at persistence/);
	assert.equal(storyReducer(state, { type: "file", file: -1 }), state);
	assert.equal(storyReducer(state, { type: "file", file: 3 }), state);
	assert.equal(storyReducer(state, { type: "file", file: 0.5 }), state);
});

test("the review order follows execution rather than sorting paths alphabetically", () => {
	assert.deepEqual(
		reviewFiles.map((f) => f.path),
		["src/routes/review.ts", "src/review/prepare.ts", "src/db/review-store.ts"]
	);
	assert.notDeepEqual(
		reviewFiles.map((f) => f.path),
		reviewFiles.map((f) => f.path).sort()
	);
	const html = render(ReviewView);
	assert(html.indexOf("Receive the request") < html.indexOf("Prepare the review"));
	assert(html.indexOf("Prepare the review") < html.indexOf("Save its progress"));
	assert.match(html, /aria-current="step"/);
});

test("flow, run request and visual explanation are different views of the same work", () => {
	const flow = render(FlowView);
	assert.match(flow, /Request/);
	assert.match(flow, /Checkpoint/);
	const run = render(FlowView, storyReducer(initialStory, { type: "flow", view: "run" }));
	assert.match(run, /bun test review\/session.test.ts/);
	assert.match(run, /does not execute the command/);
	assert.doesNotMatch(run, /tests passed|exit code 0|successfully executed/i);
	const visual = render(FlowView, storyReducer(initialStory, { type: "flow", view: "visual" }));
	assert.match(visual, /bookmark/);
	assert.match(visual, /right edition/);
});

test("proposed fixes expose the actual illustrative before/after and retain author review", () => {
	const before = render(FixView, storyReducer(initialStory, { type: "proposal", view: "before" }));
	const after = render(FixView, storyReducer(initialStory, { type: "proposal", view: "after" }));
	assert.doesNotMatch(before, /head: input.head/);
	assert.match(after, /head: input.head/);
	assert.match(after, /Author review comes next/);
	assert.doesNotMatch(after, /Merged successfully|Fix applied/);
});

test("follow-up defaults to notification and never turns a website choice into approval", () => {
	assert.match(render(FollowView), /Keep following the PR/);
	const html = render(FollowView, storyReducer(initialStory, { type: "follow", mode: "approve" }));
	assert.match(html, /explicitly authorized approval policy/);
	assert.match(html, /does not merge/);
	assert.match(html, /Example policy only/);
	assert.match(html, /exact scope, duration and permissions/);
});

test("Slack clarification reveals a bounded script and can return to the original request", () => {
	const before = render(ClarifyView);
	assert.match(before, /doesn’t load for me/);
	assert.doesNotMatch(before, /which account is affected/);
	const clarified = storyReducer(initialStory, { type: "clarify" });
	const after = render(ClarifyView, clarified);
	assert.match(after, /which account is affected/);
	assert.match(after, /With your permission/);
	assert.match(after, /billing page · team account · loading state/);
	assert.equal(storyReducer(clarified, { type: "clarify" }).clarified, false);
});

test("motion can pause independently of the selected work and chapter changes close discussions", () => {
	const paused = storyReducer(initialStory, { type: "motion" });
	assert.equal(paused.paused, true);
	assert.equal(paused.chapter, "plan");
	const next = storyReducer(
		{ ...paused, discussion: true },
		{ type: "chapter", chapter: "clarify" }
	);
	assert.equal(next.paused, true);
	assert.equal(next.discussion, false);
	assert.equal(storyReducer(next, { type: "motion" }).paused, false);
});

test("public artwork remains byte-exact and the website has no live work or media transport", () => {
	const root = new URL("../../", import.meta.url);
	const kit = new URL("../../design/muse-logo/v3/pull-forward/", root);
	for (const [original, local] of [
		["svg/pull-forward.svg", "public/brand/pull-forward.svg"],
		["svg/ui/pull-forward-32-dark.svg", "public/brand/mark-small.svg"],
		["motion/controller.mjs", "src/lib/identity/controller.mjs"],
		["motion/pull-forward.mjs", "src/lib/identity/pull-forward.mjs"],
	] as const)
		assert(readFileSync(new URL(original, kit)).equals(readFileSync(new URL(local, root))), local);
	for (const file of [
		"src/components/story/context.tsx",
		"src/components/story/views.tsx",
		"src/components/story/walkthrough.tsx",
		"src/lib/story.ts",
	])
		assert.doesNotMatch(
			readFileSync(new URL(file, root), "utf8"),
			/getUserMedia|\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/
		);
});
