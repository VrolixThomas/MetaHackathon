import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketDialogueMode } from "./foreground-dialogue";
import type { MetaItem } from "./meta-client";

const context = (displayed = true) => ({
	ticket: { id: "ops-retention", description: "Report expiry is undecided. No source supplied." },
	target: { id: "ops-retention", displayed },
});
const history: MetaItem[] = [
	{ role: "user", content: "Discuss the retention design decisions before any work." },
	{ role: "assistant", content: "A controlled unresolved product question?" },
];
function mode(text: string, displayed = true) {
	return ticketDialogueMode(
		text,
		[...history, { role: "user", content: text }],
		context(displayed)
	);
}

test("bounded planning variants use fresh topic context without a ticket-specific answer", () => {
	for (const text of [
		"Explain this ticket",
		"Talk me through the retention tradeoffs",
		"What would you recommend for the expiry decision?",
		"How should we balance convenience and risk?",
		"Why choose that lifetime?",
		"I prefer a shorter retention period.",
		"Neither; only until the download finishes.",
		"Continue?",
	])
		assert.equal(mode(text), "answer", text);
	assert.equal(
		mode("Open the ticket and discuss the design decisions", false),
		"navigate-discussion"
	);
});

test("negated/conditional navigation and cross-surface compounds retain the tool loop", () => {
	for (const text of [
		"Don't open the ticket; explain its tradeoffs here.",
		"Do not take me there, discuss the choice first.",
		"Explain it without opening anything; don't open that ticket.",
		"If it is ready, open the ticket and discuss it.",
		"Open the ticket boards and explain the priorities.",
		"Open the reviews and discuss this ticket.",
		"Open the ticket and then open another ticket; explain both.",
		"Take me to Slack and discuss the choice.",
		"Open https://example.test and discuss the ticket.",
	])
		assert.equal(mode(text, false), "tools", text);
});

test("polite/compound actions and evidence unknowns cannot disappear into a discussion stream", () => {
	for (const text of [
		"Explain the choice and could you start work on it?",
		"Discuss this, could you also please start it?",
		"What could surprise me? Please verify it.",
		"Explain this and I would like you to publish it.",
		"Discuss the tradeoff, then please publish it.",
		"I prefer expiry; also send the decision.",
		"Explain it. Can you update the setting?",
		"Why this default, and go ahead to deploy it?",
		"How should it work; remove the old record too.",
		"Explain it and close the browser.",
		"Don't start work; inspect the source and explain it.",
		"Does the implementation handle this?",
		"Why does that function behave this way?",
		"How would the caller handle failure?",
		"What does the repository say?",
		"Explain the current behavior.",
		"Analyze the architecture deeply.",
	])
		assert.equal(mode(text), "tools", text);
});

test("missing/mismatched context and standalone ambiguous choices retain capabilities", () => {
	for (const supplied of [
		undefined,
		{},
		{ ...context(), target: { id: "different", displayed: true } },
	])
		assert.equal(ticketDialogueMode("Explain the choice", [], supplied), "tools");
	assert.equal(ticketDialogueMode("Yes", [{ role: "user", content: "Yes" }], context()), "tools");
	assert.equal(mode("Could it behave differently?"), "tools");
});

test("consequence variants stream only within an established bounded planning discussion", () => {
	for (const text of [
		"What could surprise me about that choice?",
		"What happens for someone whose browser blocks storage?",
		"What if the network goes away?",
		"What would that mean for people sharing a device?",
		"How might this affect someone returning next week?",
		"Are there any downsides?",
		"What are the risks of that preference?",
	]) {
		assert.equal(mode(text), "answer", text);
		assert.equal(
			ticketDialogueMode(text, [{ role: "user", content: text }], context()),
			"tools",
			text
		);
	}
	for (const text of [
		"What happens in the current implementation?",
		"What could surprise me? Could you publish it now?",
		"What if we inspect the source first?",
		"What happens if you open the ticket boards?",
		"What are the risks? Also please start work.",
	])
		assert.equal(mode(text), "tools", text);
	const text = "What happens if that fails?";
	assert.equal(
		ticketDialogueMode(
			text,
			[
				...history,
				{ role: "user", content: "Keep it device-local." },
				{ role: "assistant", content: "Controlled choice closure without a question." },
				{ role: "user", content: "What could surprise me about that choice?" },
				{ role: "assistant", content: "Controlled consequence without a question." },
				{ role: "user", content: text },
			],
			context()
		),
		"answer"
	);
});

test("fresh selected-ticket preferences and design questions precede bare artifact nouns", () => {
	for (const text of [
		"What would you recommend so I can get back to my review easily?",
		"I prefer opening the original source separately. No coding yet.",
		"I choose a separate review window.",
		"Keep it alongside the original source.",
		"Is there anything important I still need to decide before we start?",
		"What should the export review experience be?",
		"I prefer a source link on each exported report.",
	]) {
		assert.equal(
			ticketDialogueMode(text, [{ role: "user", content: text }], context()),
			"answer",
			text
		);
		assert.equal(
			ticketDialogueMode(text, [{ role: "user", content: text }], undefined),
			"tools",
			text
		);
	}
	assert.equal(mode("What happens if the original source disappears?"), "answer");
	assert.equal(mode("I prefer opening the original source separately.", false), "tools");
});

test("planning shortcuts retain actual evidence, new targets and compound action capabilities", () => {
	for (const text of [
		"Could you actually check whether source link opens in new tab?",
		"I prefer to inspect the source code first.",
		"What would you recommend based on the current implementation?",
		"I choose the source; publish it now.",
		"I prefer to start implementation now.",
		"I prefer that you send the original source.",
		"Keep it separate and then merge the PR.",
		"I choose to run the tests first.",
		"What would you recommend for MET-81?",
		"I prefer https://example.test as the source.",
		"Open the original source separately.",
		"I prefer you open the original source separately.",
		"Why should we open the original review?",
		"Don't open the source; explain the design.",
		"If ready, open the review.",
		"Open the ticket and another review.",
	])
		assert.equal(mode(text), "tools", text);
});

test("unprompted preferences do not need a question but fragments and pending starts still do", () => {
	const thread: MetaItem[] = [
		{ role: "user", content: "What would you recommend for the source link design?" },
		{ role: "assistant", content: "A controlled proposal without a question." },
	];
	for (const text of ["I prefer opening the original source separately.", "Keep it separate."])
		assert.equal(
			ticketDialogueMode(text, [...thread, { role: "user", content: text }], context()),
			"answer"
		);
	for (const text of ["Yes", "Only separately", "Source"])
		assert.equal(
			ticketDialogueMode(text, [...thread, { role: "user", content: text }], context()),
			"tools"
		);
	for (const text of [
		"I prefer opening the original source separately.",
		"Yes",
		"Keep it separate.",
	])
		assert.equal(
			ticketDialogueMode(
				text,
				[
					{ role: "user", content: "Please start work on this ticket." },
					{ role: "assistant", content: "Discuss the source link scope: same tab or separate?" },
					{ role: "user", content: text },
				],
				context()
			),
			"tools"
		);
});

test("explicit planning continuation stays conversational without reopening execution tools", () => {
	for (const text of [
		"Continue with the decision we were discussing. No coding yet.",
		"Continue our planning discussion.",
	]) {
		assert.equal(
			ticketDialogueMode(
				text,
				[
					{ role: "user", content: "What are the tradeoffs?" },
					{ role: "assistant", content: "A benefit and a cost." },
					{ role: "user", content: text },
				],
				context()
			),
			"answer"
		);
	}
	for (const text of [
		"Continue planning, then build it.",
		"Continue the discussion and publish the work.",
		"Continue the implementation.",
	]) {
		assert.equal(ticketDialogueMode(text, [{ role: "user", content: text }], context()), "tools");
	}
});

test("a clear discussion-only preference does not need an earlier assistant question", () => {
	const text = "Across browser restarts, on this device only. We are only discussing it.";
	assert.equal(
		ticketDialogueMode(
			text,
			[
				{ role: "user", content: "Discuss the product choice." },
				{ role: "assistant", content: "A recommendation and its tradeoff." },
				{ role: "user", content: text },
			],
			context()
		),
		"answer"
	);
	assert.equal(
		ticketDialogueMode(
			text,
			[
				{ role: "user", content: "Start work on this ticket." },
				{ role: "assistant", content: "Which lifetime?" },
				{ role: "user", content: text },
			],
			context()
		),
		"tools"
	);
});
