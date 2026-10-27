import assert from "node:assert/strict";
import { it } from "node:test";
import type { ReviewInbox } from "../../shared/contracts";
import { createPreparedApi } from "./api";
import { createPreparedController } from "./controller";

const empty: ReviewInbox = {
	repository: null,
	items: [],
	refreshing: false,
	lastRefreshedAt: null,
};
it("connects only a valid explicit repository and displays server-reported states", async () => {
	const calls: Array<{ path: string; input: unknown }> = [];
	let current = empty;
	const api = createPreparedApi(async (_type, path, input) => {
		calls.push({ path, input });
		if (path === "reviews.connect")
			current = { ...empty, repository: "owner/project", refreshing: true };
		return current;
	});
	const ui = createPreparedController(api, "session");
	try {
		assert.equal(ui.store.getState().inbox, null);
		await ui.connect("https://github.com/owner/project");
		assert.equal(calls.length, 0);
		await ui.connect(" owner/project ");
		assert.deepEqual(calls, [{ path: "reviews.connect", input: { repository: "owner/project" } }]);
		assert.deepEqual(ui.store.getState().inbox, current);
		current = { ...current, refreshing: false, lastRefreshedAt: "2026-10-27T22:00:00Z" };
		await ui.poll();
		assert.deepEqual(ui.store.getState().inbox, current);
		assert.equal(
			calls.some((call) => call.path === "reviews.prepare"),
			false
		);
	} finally {
		ui.dispose();
	}
});
it("does not restore the old repository from a poll that finishes after a new connection", async () => {
	let resolveOld: (value: ReviewInbox) => void = () => {};
	const connected = { ...empty, repository: "new/repository" };
	const api = createPreparedApi(async (_type, path) =>
		path === "reviews.connect"
			? connected
			: new Promise<ReviewInbox>((resolve) => {
					resolveOld = resolve;
				})
	);
	const ui = createPreparedController(api, "session");
	try {
		const polling = ui.poll();
		await ui.connect("new/repository");
		resolveOld({ ...empty, repository: "old/repository" });
		await polling;
		assert.equal(ui.store.getState().inbox?.repository, "new/repository");
	} finally {
		ui.dispose();
	}
});
it("reports unavailable inbox without inventing review results", async () => {
	const ui = createPreparedController(
		createPreparedApi(async () => {
			throw new Error("offline");
		}),
		"session"
	);
	try {
		await ui.poll();
		assert.equal(ui.store.getState().inbox, null);
		assert.ok(ui.store.getState().error);
	} finally {
		ui.dispose();
	}
});
