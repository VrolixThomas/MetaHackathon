import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceService } from "./service";
import type { VoiceBackend } from "./sidecar";

const identity = { sessionId: "session", turnId: "turn", generation: 1 };
const offer = { ...identity, type: "offer" as const, sdp: "offer", keywords: [] };
const answer = { type: "answer", sdp: "answer" };
function deferred<T>() {
	let resolve!: (result: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function backend(request: VoiceBackend["request"]): VoiceBackend {
	return { request, dispose: async () => {} };
}
describe("voice main generation boundary", () => {
	it("cancel before offer tombstones the generation without admitting media", async () => {
		const calls: string[] = [];
		const service = new VoiceService(
			backend(async (path) => {
				calls.push(path);
				return {};
			})
		);
		await service.cancel(identity);
		assert.throws(() => service.offer(offer), /Stale/);
		assert.deepEqual(calls, ["cancel"]);
	});
	it("cancel during uncooperative offer rejects the late answer and sends cleanup", async () => {
		const pending = deferred<unknown>();
		const calls: string[] = [];
		const service = new VoiceService(
			backend(async (path) => {
				calls.push(path);
				return path === "offer" ? pending.promise : {};
			})
		);
		const result = service.offer(offer);
		const rejection = assert.rejects(result, /Stale/);
		await service.cancel(identity);
		pending.resolve(answer);
		await rejection;
		assert.deepEqual(calls, ["offer", "cancel", "cancel"]);
	});
	it("deduplicates identical offer but denies conflicting same-generation SDP", async () => {
		let count = 0;
		const service = new VoiceService(
			backend(async () => {
				count++;
				return answer;
			})
		);
		const first = service.offer(offer);
		assert.equal(service.offer(offer), first);
		await first;
		assert.throws(() => service.offer({ ...offer, sdp: "changed" }), /Stale/);
		assert.equal(count, 1);
	});
	it("old cancels cannot kill a newer turn and old events cannot leak into it", async () => {
		const calls: string[] = [];
		const service = new VoiceService(
			backend(async (path) => {
				calls.push(path);
				return path === "offer"
					? answer
					: {
							events: [{ ...identity, sequence: 1, kind: "transcript", text: "late", final: true }],
						};
			})
		);
		await service.offer(offer);
		const next = { ...identity, turnId: "next", generation: 2 };
		await service.offer({ ...offer, ...next });
		await service.cancel(identity);
		await assert.rejects(service.poll({ ...next, afterSequence: 0 }), /Invalid voice event/);
		assert.equal(calls.includes("cancel"), false);
	});
	it("drops late polled transcripts after cancellation and rejects sequence regression", async () => {
		const pending = deferred<unknown>();
		const service = new VoiceService(
			backend(async (path) => (path === "offer" ? answer : path === "poll" ? pending.promise : {}))
		);
		await service.offer(offer);
		const result = service.poll({ ...identity, afterSequence: 0 });
		const rejected = assert.rejects(result, /Stale/);
		await service.cancel(identity);
		pending.resolve({
			events: [{ ...identity, sequence: 1, kind: "transcript", text: "late", final: true }],
		});
		await rejected;
		const second = new VoiceService(
			backend(async (path) =>
				path === "offer"
					? answer
					: { events: [{ ...identity, sequence: 1, kind: "transcript", text: "old", final: true }] }
			)
		);
		await second.offer(offer);
		await assert.rejects(second.poll({ ...identity, afterSequence: 1 }), /sequence/);
	});
	it("dispose stops admission and backend teardown is called once", async () => {
		let disposed = 0;
		const service = new VoiceService({
			request: async () => answer,
			dispose: async () => {
				disposed++;
			},
		});
		await service.offer(offer);
		await Promise.all([service.dispose(), service.dispose()]);
		assert.throws(() => service.offer({ ...offer, generation: 2 }), /shut down/);
		assert.equal(disposed, 1);
	});
});
