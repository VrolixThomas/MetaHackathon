import assert from "node:assert/strict";
import { it } from "node:test";
import type { ElectronAPI } from "../../shared/types";
import { connectShortcuts } from "./shortcuts";
it("routes only explicit native voice events and unsubscribes", () => {
	const calls: string[] = [];
	let listener: Parameters<ElectronAPI["voiceShortcut"]["subscribe"]>[0] = () => {};
	const disconnect = connectShortcuts(
		{
			subscribe: (value) => {
				listener = value;
				return () => {
					calls.push("unsubscribed");
				};
			},
		},
		{
			press: () => {
				calls.push("press");
			},
			release: () => {
				calls.push("release");
			},
			toggle: () => {
				calls.push("toggle");
			},
			stop: (reason) => {
				calls.push(`stop:${reason}`);
			},
		}
	);
	for (const phase of ["press", "release", "toggle", "cancel"] as const) listener({ phase });
	disconnect();
	assert.deepEqual(calls, ["press", "release", "toggle", "stop:escape", "unsubscribed"]);
});
