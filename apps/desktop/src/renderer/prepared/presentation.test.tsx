import assert from "node:assert/strict";
import { it } from "node:test";
import type { MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreparedReview, ReviewFile } from "../../shared/contracts";
import { createConversationApi } from "../conversation/api";
import { createConversationController } from "../conversation/controller";
import {
	ReviewActionButton,
	ReviewWorkspace,
	cleanExplanation,
	explanationPreview,
} from "./ReviewWorkspace";
import { createPreparedApi } from "./api";
import { createPreparedController } from "./controller";

it("shortens cached prose only in the preview and retains uncertainty", () => {
	const text = `Inferred: Inferred summary: This may change validation. ${"Further source details. ".repeat(25)}Final caveat.`;
	assert.equal(explanationPreview(text), "This may change validation.");
	assert.ok(cleanExplanation(text).endsWith("Final caveat."));
	assert.equal(
		cleanExplanation("Inferred from partial source; intent is unknown."),
		"Inferred from partial source; intent is unknown."
	);
	assert.ok(explanationPreview("word ".repeat(100)).length <= 170);
});

it("manual review controls retire the reply before navigation while leaving hands-free armed", () => {
	const events: string[] = [];
	const conversation = createConversationController(
		createConversationApi(async () => {
			throw new Error("No IPC expected");
		})
	);
	conversation.attachHandsFree({
		start: async () => {},
		stop: () => events.push("stop-mic"),
		interrupt: () => events.push("interrupt"),
	});
	conversation.store.setState({ handsFree: true });
	const turn = conversation.allocateIdentity();
	conversation.beginVoice(turn);
	try {
		const button = ReviewActionButton({
			onInteraction: conversation.interruptReply,
			onClick: () => {
				assert.equal(conversation.store.getState().active, null);
				assert.equal(conversation.store.getState().handsFree, true);
				events.push("navigate");
			},
		});
		// Rendering or changing observed source is not a user interaction.
		renderToStaticMarkup(button);
		assert.deepEqual([...events], []);
		button.props.onClick({} as MouseEvent<HTMLButtonElement>);
		assert.deepEqual([...events], ["interrupt", "navigate"]);
		conversation.answer(turn, "Old file narration arriving late");
		assert.equal(conversation.store.getState().exchanges.at(-1)?.answer, "");
		assert.equal(conversation.store.getState().handsFree, true);
		ReviewActionButton({
			disabled: true,
			onInteraction: conversation.interruptReply,
			onClick: () => events.push("disabled-navigation"),
		}).props.onClick({} as MouseEvent<HTMLButtonElement>);
		assert.deepEqual([...events], ["interrupt", "navigate"]);
	} finally {
		conversation.dispose();
	}
});

it("keeps complete cached notes behind closed disclosures and preserves pinned code identity", () => {
	const pr = {
		id: "owner/project#3",
		repository: "owner/project",
		number: 3,
		title: "Source change",
		url: "https://github.com/owner/project/pull/3",
		author: "owner",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
	};
	const plan: PreparedReview = {
		id: "prepared-3",
		version: 1,
		pr,
		createdAt: "2026-10-27T22:00:00Z",
		summary: `Inferred: Inferred: ${"Full overview. ".repeat(100)}Overview final caveat.`,
		orderRationale: "Inferred: Read the public interface first.",
		files: [
			{
				path: "src/interface.ts",
				summary: `Inferred: Inferred: Validation may change. ${"Additional detail. ".repeat(60)}Summary final caveat.`,
				reason: `Inferred: Entry point first. ${"Dependency detail. ".repeat(30)}Reason final caveat.`,
				suggestedComments: [{ id: "draft-3", body: "Could this affect existing callers?" }],
			},
		],
		coverage: "partial",
		evidence: "inferred-from-github",
	};
	const file: ReviewFile = {
		prId: pr.id,
		path: "src/interface.ts",
		status: "modified",
		patch: "@@ -1 +1 @@\n-const old = 1;\n+const next = 2;",
		base: {
			path: "src/interface.ts",
			commitSha: pr.baseSha,
			status: "available",
			content: "const old = 1;\n",
		},
		head: {
			path: "src/interface.ts",
			commitSha: pr.headSha,
			status: "available",
			content: "const next = 2;\n",
		},
	};
	const controller = createPreparedController(
		createPreparedApi(async () => {
			throw new Error("Rendering must not call IPC");
		}),
		"session"
	);
	try {
		controller.store.setState({
			detail: { pr, status: "ready", prepared: plan, progress: null },
			file,
			screen: {
				mode: "review",
				sequence: 7,
				prId: pr.id,
				reviewId: plan.id,
				path: file.path,
				baseSha: pr.baseSha,
				headSha: pr.headSha,
			},
		});
		const render = (navigationBusy = false) =>
			renderToStaticMarkup(
				<ReviewWorkspace
					controller={{
						...controller,
						store: { ...controller.store, getInitialState: controller.store.getState },
					}}
					onInteraction={() => {}}
					navigationBusy={navigationBusy}
				/>
			);
		const html = render();
		const sourceTabs = (value: string) =>
			value.match(/<nav class="source-tabs"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
		assert.equal((sourceTabs(render(true)).match(/disabled=""/g) ?? []).length, 3);
		assert.equal((sourceTabs(html).match(/disabled=""/g) ?? []).length, 0);
		assert.match(html, /What changes/);
		assert.match(html, /Why this file now/);
		assert.match(html, /File 1 of 1/);
		assert.match(html, /Partial coverage/);
		assert.match(html, /not verified author intent/);
		assert.match(html, /Inferred drafts · not posted/);
		assert.doesNotMatch(html, /<details[^>]* open|Inferred: Inferred|<iframe/);
		for (const tail of [
			"Overview final caveat.",
			"Summary final caveat.",
			"Reason final caveat.",
			"Could this affect existing callers?",
		])
			assert.ok(html.includes(tail));
		const previews = [...html.matchAll(/class="explanation-preview">([^<]*)/g)].map(
			(match) => match[1]
		);
		assert.deepEqual(previews, ["Validation may change.", "Entry point first."]);
		assert.match(html, /data-review-path="src\/interface.ts"[^>]*data-screen-sequence="7"/);
		assert.match(html, new RegExp(`data-base-sha="${pr.baseSha}" data-head-sha="${pr.headSha}"`));
		assert.match(html, /<code>const next = 2;<\/code>/);
		assert.ok(html.indexOf('class="real-source"') < html.indexOf('class="review-details"'));
	} finally {
		controller.dispose();
	}
});
