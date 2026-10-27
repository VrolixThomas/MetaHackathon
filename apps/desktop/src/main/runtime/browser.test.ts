import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserCommand } from "../../shared/contracts";
import { type BrowserPage, BrowserService, type BrowserSnapshot } from "./browser";
import { allowedBrowserURL, browserURL, previewOrigin } from "./browser-policy";

const open = {
	kind: "open",
	sessionId: "conversation",
	requestId: "open",
	prId: "demo/shop#1",
	revision: "head",
} as const;
function fixture(timeoutMs = 1000, finishClose: () => Promise<void> = async () => {}) {
	// Deliberately fake page port: these tests prove service ownership, not native DOM execution.
	const pages: Array<
		BrowserPage & {
			data: BrowserSnapshot;
			closed: boolean;
			actions: number;
			loads: number;
			onAct?: () => Promise<void>;
		}
	> = [];
	let stopped = 0;
	const service = new BrowserService({
		timeoutMs,
		async openPreview(command) {
			return {
				prId: command.prId,
				repository: "demo/shop",
				revision: command.revision,
				commitSha: (command.revision === "head" ? "a" : "b").repeat(40),
				url: "http://127.0.0.1:43210/checkout?runId=test",
				async close() {
					stopped++;
					await finishClose();
				},
			};
		},
		createPage() {
			const page = {
				data: {
					url: "",
					title: "Fake test page",
					text: "Original",
					elements: [
						{
							id: "button-1",
							tag: "button",
							role: "button",
							name: "Apply",
							bounds: { x: 10, y: 10, width: 80, height: 30 },
							visible: true,
							enabled: true,
						},
					],
					scroll: { x: 0, y: 0 },
				} as BrowserSnapshot,
				closed: false,
				actions: 0,
				loads: 0,
				onAct: undefined as (() => Promise<void>) | undefined,
				async loadURL(url: string) {
					assert.equal(this.closed, false);
					this.data.url = url;
					this.loads++;
				},
				async snapshot() {
					assert.equal(this.closed, false);
					return structuredClone(this.data);
				},
				async act() {
					assert.equal(this.closed, false);
					this.actions++;
					if (this.onAct) await this.onAct();
					this.data.text = "Changed";
				},
				async viewport() {
					assert.equal(this.closed, false);
				},
				present() {
					assert.equal(this.closed, false);
				},
				close() {
					this.closed = true;
				},
			};
			pages.push(page);
			return page;
		},
	});
	return { service, pages, stopped: () => stopped };
}

test("browser persists one page, advances sequence only on change and returns actual post-action state", async () => {
	const f = fixture();
	try {
		const initial = await f.service.execute(open);
		assert.deepEqual(initial.viewport, { width: 1024, height: 768 });
		assert.equal((await f.service.observe(open.sessionId))?.sequence, initial.sequence);
		const again = await f.service.execute({ ...open, requestId: "again" });
		assert.equal(again.browserId, initial.browserId);
		assert.equal(f.pages.length, 1);
		assert.equal(f.pages[0]?.loads, 1);
		const click: BrowserCommand = {
			kind: "click",
			sessionId: open.sessionId,
			requestId: "click",
			browserId: initial.browserId,
			elementId: "button-1",
			observationSequence: initial.sequence,
		};
		const changed = await f.service.execute(click);
		assert.equal(changed.text, "Changed");
		assert.equal(changed.sequence, initial.sequence + 1);
		await assert.rejects(f.service.execute(click), /already submitted/);
		await assert.rejects(
			f.service.execute({ ...click, requestId: "stale" }),
			/Stale browser observation/
		);
		assert.equal(f.pages[0]?.actions, 1);
		const phone = await f.service.execute({
			kind: "viewport",
			sessionId: open.sessionId,
			requestId: "phone",
			browserId: initial.browserId,
			viewport: { width: 390, height: 844 },
		});
		assert.deepEqual(phone.viewport, { width: 390, height: 844 });
		assert.equal(phone.browserId, initial.browserId);
	} finally {
		await f.service.dispose();
	}
	assert.equal(f.stopped(), 1);
});

test("manual page changes invalidate refs; base switch owns a new page and exact SHA", async () => {
	const f = fixture();
	try {
		const state = await f.service.execute(open);
		const page = f.pages[0];
		assert.ok(page);
		page.data.text = "Human changed page";
		await assert.rejects(
			f.service.execute({
				kind: "click",
				sessionId: open.sessionId,
				requestId: "late",
				browserId: state.browserId,
				elementId: "button-1",
				observationSequence: state.sequence,
			}),
			/Stale browser observation/
		);
		const base = await f.service.execute({ ...open, requestId: "base", revision: "base" });
		assert.equal(base.commitSha, "b".repeat(40));
		assert.equal(base.revision, "base");
		assert.notEqual(base.browserId, state.browserId);
		assert.equal(page.closed, true);
		assert.equal(f.stopped(), 1);
		await assert.rejects(
			f.service.execute({
				kind: "viewport",
				sessionId: open.sessionId,
				requestId: "old-browser",
				browserId: state.browserId,
				viewport: { width: 390, height: 844 },
			}),
			/Stale browser session/
		);
	} finally {
		await f.service.dispose();
	}
});

test("cancellation destroys the page before late action completion and rejects queued aborted work", async () => {
	const f = fixture();
	const controller = new AbortController();
	let finish = () => {};
	let entered = () => {};
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	try {
		const state = await f.service.execute(open);
		const page = f.pages[0];
		assert.ok(page);
		page.onAct = async () => {
			entered();
			await pending;
		};
		const action = f.service.execute(
			{
				kind: "click",
				sessionId: open.sessionId,
				requestId: "cancel",
				browserId: state.browserId,
				elementId: "button-1",
				observationSequence: state.sequence,
			},
			controller.signal
		);
		await started;
		controller.abort();
		await assert.rejects(action, /cancelled/);
		assert.equal(page.closed, true);
		assert.equal(await f.service.observe(open.sessionId), null);
		finish();
		await delay(1);
		assert.equal(await f.service.observe(open.sessionId), null);
		await assert.rejects(
			f.service.execute({ ...open, requestId: "pre-aborted" }, controller.signal)
		);
		assert.equal(f.pages.length, 1);
	} finally {
		finish();
		await f.service.dispose();
	}
	assert.equal(f.stopped(), 1);
});

test("shutdown cancels in-flight and queued operations without executing late mutations", async () => {
	const f = fixture();
	const state = await f.service.execute(open);
	const page = f.pages[0];
	assert.ok(page);
	let entered = () => {};
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	page.onAct = async () => {
		entered();
		await new Promise(() => {});
	};
	const command = {
		kind: "click",
		sessionId: open.sessionId,
		requestId: "first",
		browserId: state.browserId,
		elementId: "button-1",
		observationSequence: state.sequence,
	} as const;
	const first = f.service.execute(command);
	await started;
	const second = f.service.execute({ ...command, requestId: "queued" });
	const results = Promise.allSettled([first, second]);
	await Promise.all([f.service.dispose(), f.service.dispose()]);
	assert.deepEqual(
		(await results).map((x) => x.status),
		["rejected", "rejected"]
	);
	assert.equal(page.actions, 1);
	assert.equal(f.stopped(), 1);
	await assert.rejects(f.service.observe(open.sessionId), /shut down/);
});

test("navigation and observed state cannot escape the exact owned preview origin", async () => {
	const f = fixture();
	try {
		const state = await f.service.execute(open);
		for (const url of [
			"https://example.com/?secret=x",
			"http://127.0.0.1:1/",
			"file:///etc/passwd",
			"http://user:secret@127.0.0.1:43210/",
		]) {
			await assert.rejects(
				f.service.execute({
					kind: "navigate",
					sessionId: open.sessionId,
					requestId: url,
					browserId: state.browserId,
					url,
				}),
				/outside/
			);
		}
		const page = f.pages[0];
		assert.ok(page);
		assert.equal(page.loads, 1);
		page.data.url = "https://example.com/";
		await assert.rejects(f.service.observe(open.sessionId), /left its active preview/);
		assert.equal(page.closed, true);
	} finally {
		await f.service.dispose();
	}
	assert.equal(previewOrigin("http://127.0.0.1:43210/checkout"), "http://127.0.0.1:43210");
	assert.equal(
		browserURL("/cart", "http://127.0.0.1:43210/checkout"),
		"http://127.0.0.1:43210/cart"
	);
	assert.equal(
		browserURL("/cart", "http://127.0.0.1:43210/checkout?runId=owned"),
		"http://127.0.0.1:43210/cart?runId=owned"
	);
	assert.equal(allowedBrowserURL("http://localhost:43210/", "http://127.0.0.1:43210"), false);
});

test("an owned preview that resolves after cancellation is closed without creating a page", async () => {
	let deliver = () => {};
	let stopped = 0;
	const signal = new AbortController();
	const pending = new Promise<void>((resolve) => {
		deliver = resolve;
	});
	const service = new BrowserService({
		async openPreview() {
			await pending;
			return {
				prId: open.prId,
				repository: "demo/shop",
				revision: "head",
				commitSha: "a".repeat(40),
				url: "http://127.0.0.1:43210/",
				async close() {
					stopped++;
				},
			};
		},
		createPage() {
			throw Error("Must not create a late page");
		},
	});
	const action = service.execute(open, signal.signal);
	await delay(1);
	signal.abort();
	deliver();
	await assert.rejects(action);
	await service.dispose();
	assert.equal(stopped, 1);
});

for (const previouslyAborted of [false, true])
	test(`close awaits preview cleanup (already aborted: ${previouslyAborted})`, async () => {
		const controller = new AbortController();
		let finish = () => {};
		const cleanup = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const f = fixture(1000, () => cleanup);
		const state = await f.service.execute(open);
		const page = f.pages[0];
		assert.ok(page);
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		page.onAct = async () => {
			entered();
			await new Promise(() => {});
		};
		const action = assert.rejects(
			f.service.execute(
				{
					kind: "click",
					sessionId: open.sessionId,
					requestId: "close-race",
					browserId: state.browserId,
					elementId: "button-1",
					observationSequence: state.sequence,
				},
				controller.signal
			)
		);
		await started;
		if (previouslyAborted) {
			controller.abort();
			await action;
		}
		let settled = false;
		const closing = f.service.close(open.sessionId).then(() => {
			settled = true;
		});
		await action;
		await delay(1);
		try {
			assert.equal(settled, false);
			assert.equal(page.closed, true);
		} finally {
			finish();
			await closing;
			await f.service.dispose();
		}
		assert.equal(f.stopped(), 1);
	});
