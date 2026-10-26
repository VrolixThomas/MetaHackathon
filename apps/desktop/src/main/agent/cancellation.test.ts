import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { abortable } from "./cancellation";

test("already-aborted operations observe immediate and late adapter rejections", async () => {
	const controller = new AbortController();
	controller.abort();
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await assert.rejects(
			abortable(Promise.reject(new Error("adapter rejected")), controller.signal),
			{ name: "AbortError" }
		);
		let rejectLate: (error: Error) => void = () => {};
		const late = new Promise<never>((_, reject) => {
			rejectLate = reject;
		});
		await assert.rejects(abortable(late, controller.signal), { name: "AbortError" });
		rejectLate(new Error("late adapter rejection"));
		await setImmediate();
		assert.deepEqual(unhandled, []);
	} finally {
		process.removeListener("unhandledRejection", onUnhandled);
	}
});

test("aborted pending adapter cannot produce a late result or unhandled rejection", async () => {
	const controller = new AbortController();
	let rejectLate: (error: Error) => void = () => {};
	const operation = new Promise<never>((_, reject) => {
		rejectLate = reject;
	});
	const pending = abortable(operation, controller.signal);
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
	rejectLate(new Error("late failure"));
	await setImmediate();
});
