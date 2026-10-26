import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { startUpdateCheck } from "./updates";

describe("packaged update startup", () => {
	it("never starts update requests in a development build", async () => {
		const events = new EventEmitter();
		let checks = 0;
		const updater = Object.assign(events, {
			async checkForUpdatesAndNotify() {
				checks++;
			},
		});
		await startUpdateCheck(false, updater, () => assert.fail("Development must not check updates"));
		assert.equal(checks, 0);
		assert.equal(events.listenerCount("error"), 0);
	});

	it("checks packaged builds and handles rejected checks and later error events", async () => {
		const failure = new Error("Release feed unavailable");
		const errors: unknown[] = [];
		const events = new EventEmitter();
		let checks = 0;
		const updater = Object.assign(events, {
			async checkForUpdatesAndNotify() {
				checks++;
				throw failure;
			},
		});
		await startUpdateCheck(true, updater, (error) => errors.push(error));
		assert.equal(checks, 1);
		assert.deepEqual(errors, [failure]);
		events.emit("error", failure);
		assert.deepEqual(errors, [failure, failure]);
	});
});
