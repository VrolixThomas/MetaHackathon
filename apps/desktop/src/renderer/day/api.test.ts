import assert from "node:assert/strict";
import { it } from "node:test";
import type { DayOperateInput } from "../../shared/contracts/day";
import { createDayApi } from "./api";
import { snapshot, workItem } from "./test-support";

it("validates snapshots without inventing work on a malformed or cross-account result", async () => {
	for (const raw of [
		{ ...snapshot(), samples: [] },
		{ ...snapshot(), items: [{ ...workItem(), ownerUserId: "someone-else" }] },
	]) {
		const api = createDayApi(async () => raw);
		await assert.rejects(() => api.snapshot());
	}
});

it("uses the local IPC routes with independent IDs and preserves the exact reply confirmation", async () => {
	const calls: unknown[] = [];
	const inputs: DayOperateInput[] = [];
	const api = createDayApi(async (type, path, input) => {
		calls.push([type, path]);
		if (path === "day.snapshot") return snapshot();
		const parsed = input as DayOperateInput;
		inputs.push(parsed);
		return { requestId: parsed.requestId, itemId: "item", snapshot: snapshot() };
	});
	await api.snapshot();
	const operation = {
		kind: "send_reply",
		itemId: "item",
		expectedRevision: 4,
		draftRevision: 2,
		body: " Exact answer\n\twith spaces ",
	} as const;
	await api.operate(operation);
	await api.operate(operation);
	assert.deepEqual(calls, [
		["query", "day.snapshot"],
		["mutation", "day.operate"],
		["mutation", "day.operate"],
	]);
	assert.deepEqual(inputs[0]?.operation, operation);
	assert.notEqual(inputs[0]?.requestId, inputs[1]?.requestId);
});

it("rejects a reply receipt for another request or item and invalid inputs before IPC", async () => {
	let count = 0;
	for (const wrong of ["request", "item"]) {
		const api = createDayApi(async (_type, _path, raw) => {
			count++;
			const input = raw as DayOperateInput;
			return {
				requestId: wrong === "request" ? "foreign" : input.requestId,
				itemId: wrong === "item" ? "foreign" : "item",
				snapshot: snapshot(),
			};
		});
		await assert.rejects(
			() => api.operate({ kind: "cover", itemId: "item", expectedRevision: 3 }),
			/identity mismatch/
		);
		await assert.rejects(() =>
			api.operate({
				kind: "answer_question",
				itemId: "item",
				expectedRevision: 3,
				questionId: "question",
				answer: "",
			})
		);
	}
	assert.equal(count, 2);
});

it("reuses the exact request identity after acknowledgement loss, then retires it after confirmation", async () => {
	const requests: DayOperateInput[] = [];
	const api = createDayApi(async (_type, _path, input) => {
		const request = input as DayOperateInput;
		requests.push(request);
		if (requests.length === 1) throw new Error("Acknowledgement lost after save");
		return { requestId: request.requestId, itemId: "item", snapshot: snapshot() };
	});
	const operation = {
		kind: "capture_manual",
		title: "User captured follow-up",
		summary: "",
		itemKind: "follow_up",
	} as const;
	await assert.rejects(() => api.operate(operation));
	await api.operate(operation);
	await api.operate(operation);
	assert.equal(requests[0]?.requestId, requests[1]?.requestId);
	assert.notEqual(requests[1]?.requestId, requests[2]?.requestId);
	assert.deepEqual(requests[0]?.operation, requests[1]?.operation);
});
