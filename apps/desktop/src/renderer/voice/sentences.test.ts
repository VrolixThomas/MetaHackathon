import assert from "node:assert/strict";
import { test } from "node:test";
import { Sentences } from "./sentences";

test("temporary delta end is not a sentence boundary inside a decimal", () => {
	const sentences = new Sentences();
	assert.deepEqual(sentences.push("The cap is 40."), []);
	assert.deepEqual(sentences.push("5%. Next"), ["The cap is 40.5%."]);
	assert.deepEqual(sentences.push(" answer."), []);
	assert.deepEqual(sentences.push("", true), ["Next answer."]);
});

test("arbitrary token boundaries preserve decimals, punctuation and closing quotes", () => {
	const text = 'The cap is 40.5%. "Next answer!" A final question?';
	const expected = ["The cap is 40.5%.", '"Next answer!"', "A final question?"];
	for (let size = 1; size <= text.length; size++) {
		const sentences = new Sentences();
		const output: string[] = [];
		for (let index = 0; index < text.length; index += size)
			output.push(...sentences.push(text.slice(index, index + size)));
		output.push(...sentences.push("", true));
		assert.deepEqual(output, expected, `chunk size ${size}`);
	}
});

test("whitespace permits streaming before final and long speech chunks stay bounded", () => {
	const sentences = new Sentences();
	assert.deepEqual(sentences.push("Ready."), []);
	assert.deepEqual(sentences.push(" Next"), ["Ready."]);
	const output = [...sentences.push(` ${"x".repeat(4500)}. `), ...sentences.push("", true)];
	assert.ok(output.every((chunk) => chunk.length <= 1000));
	assert.equal(output.join("").replaceAll(" ", ""), `Next${"x".repeat(4500)}.`);
});

test("checkpoint flushes can repeat and admit later segments without replay or completion text", () => {
	const sentences = new Sentences();
	assert.deepEqual(sentences.push("First sentence. Pending first segment"), ["First sentence."]);
	assert.deepEqual(sentences.flush(), ["Pending first segment"]);
	assert.deepEqual(sentences.flush(), []);
	assert.deepEqual(sentences.push(" Next segment, 40."), []);
	assert.deepEqual(sentences.push("5%. Tail"), ["Next segment, 40.5%."]);
	assert.deepEqual(sentences.flush(), ["Tail"]);
	assert.deepEqual(sentences.push("", true), []);
});
