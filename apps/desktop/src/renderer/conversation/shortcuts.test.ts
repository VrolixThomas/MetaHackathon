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
			interruptReply() {},
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

it("lets dialogs consume Escape while an unhandled Escape ends the voice session", () => {
	const keyboard = new EventTarget();
	const calls: string[] = [];
	const disconnect = connectShortcuts(
		undefined,
		{
			interruptReply() {},
			press() {},
			release() {},
			toggle() {},
			stop(reason) {
				calls.push(String(reason));
			},
		},
		keyboard as unknown as Window
	);
	const escaped = (prevented: boolean) => {
		const event = Object.assign(new Event("keydown", { cancelable: true }), {
			key: "Escape",
			isComposing: false,
		});
		if (prevented) event.preventDefault();
		keyboard.dispatchEvent(event);
	};
	escaped(true);
	assert.deepEqual(calls, []);
	escaped(false);
	assert.deepEqual(calls, ["escape"]);
	disconnect();
	escaped(false);
	assert.deepEqual(calls, ["escape"]);
});

it("Command/Control period interrupts only the reply and ignores ordinary typing", () => {
	const keyboard = new EventTarget();
	let replies = 0;
	let stops = 0;
	const disconnect = connectShortcuts(
		undefined,
		{
			press() {},
			release() {},
			toggle() {},
			stop() {
				stops++;
			},
			interruptReply() {
				replies++;
			},
		},
		keyboard as unknown as Window
	);
	const key = (extra: object = {}) =>
		keyboard.dispatchEvent(
			Object.assign(new Event("keydown", { cancelable: true }), {
				key: ".",
				metaKey: false,
				ctrlKey: false,
				isComposing: false,
				repeat: false,
				...extra,
			})
		);
	key();
	key({ metaKey: true, repeat: true });
	key({ metaKey: true, isComposing: true });
	assert.equal(replies, 0);
	key({ metaKey: true });
	key({ ctrlKey: true });
	assert.equal(replies, 2);
	assert.equal(stops, 0);
	disconnect();
	key({ metaKey: true });
	assert.equal(replies, 2);
});
