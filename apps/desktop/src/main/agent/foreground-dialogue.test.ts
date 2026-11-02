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
