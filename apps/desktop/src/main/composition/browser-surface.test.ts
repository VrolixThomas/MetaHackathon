import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserBounds, BrowserViewport } from "../../shared/contracts";
import type { BrowserPage, BrowserSnapshot } from "../runtime/browser";
import { LocalBrowserSurface, createLocalBrowserRouter } from "./browser-surface";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function promptly<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Operation did not settle promptly")), 500);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Deliberately fake page: no Electron, server, browser launch or network in these tests. */
class FakePage implements BrowserPage {
	data: BrowserSnapshot = {
		url: "about:blank",
		title: "Test page",
		text: "",
		elements: [],
		scroll: { x: 0, y: 0 },
	};
	loads: string[] = [];
	viewports: BrowserViewport[] = [];
	presentations: (BrowserBounds | null)[] = [];
	snapshots = 0;
	closes = 0;
	onLoad?: () => Promise<void>;
	onSnapshot?: () => Promise<BrowserSnapshot>;
	onViewport?: () => Promise<void>;
	history?: () => { canGoBack: boolean; canGoForward: boolean };
	back?: () => Promise<void>;
	forward?: () => Promise<void>;
	reload?: () => Promise<void>;
	async loadURL(url: string) {
		assert.equal(this.closes, 0);
		this.loads.push(url);
		await this.onLoad?.();
		this.data.url = url;
	}
	async snapshot() {
		assert.equal(this.closes, 0);
		this.snapshots++;
		return this.onSnapshot ? this.onSnapshot() : structuredClone(this.data);
	}
	async act() {
		throw new Error("Surface must not invoke PR browser automation");
	}
	async viewport(value: BrowserViewport) {
		assert.equal(this.closes, 0);
		this.viewports.push(structuredClone(value));
		await this.onViewport?.();
	}
	present(value: BrowserBounds | null) {
		assert.equal(this.closes, 0);
		this.presentations.push(structuredClone(value));
	}
	close() {
		this.closes++;
	}
}
function fixture(configure: (page: FakePage) => void = () => {}, timeoutMs = 1000) {
	const pages: FakePage[] = [];
	const origins: string[] = [];
	const surface = new LocalBrowserSurface({
		timeoutMs,
		createPage(origin) {
			assert(
				pages.every((page) => page.closes === 1),
				"Prior origin must close before creating another page"
			);
			const page = new FakePage();
			configure(page);
			pages.push(page);
			origins.push(origin);
			return page;
		},
	});
	return { surface, pages, origins };
}

test("lazy surface persists same-origin pages and polls actual navigation without claiming a revision", async () => {
	const f = fixture();
	try {
		assert.equal(await f.surface.state(), null);
		assert.equal(f.pages.length, 0);
		const first = await f.surface.open({ url: "http://localhost:3000/one" });
		assert.deepEqual(first, {
			url: "http://localhost:3000/one",
			title: "Test page",
			viewport: { width: 1024, height: 768 },
			canGoBack: false,
			canGoForward: false,
			provenance: "local-preview-unverified-revision",
		});
		assert.deepEqual(f.origins, ["http://localhost:3000"]);
		assert.deepEqual(f.pages[0]?.viewports, [{ width: 1024, height: 768 }]);
		await f.surface.command({ kind: "navigate", url: "http://localhost:3000/two" });
		await f.surface.open({ url: "http://localhost:3000/three" });
		assert.equal(f.pages.length, 1);
		const page = f.pages[0];
		assert(page);
		page.data.url = "http://localhost:3000/user-navigation";
		page.data.title = "Changed by the user";
		const polled = await f.surface.state();
		assert.equal(polled?.url, page.data.url);
		assert.equal(polled?.title, page.data.title);
		assert.equal("commitSha" in (polled ?? {}), false);
		await f.surface.command({ kind: "navigate", url: "http://127.0.0.1:3001/new-origin" });
		assert.equal(page.closes, 1);
		assert.equal(f.pages.length, 2);
		await f.surface.open({ url: "http://[::1]:3001/ipv6" });
		assert.deepEqual(f.origins, [
			"http://localhost:3000",
			"http://127.0.0.1:3001",
			"http://[::1]:3001",
		]);
	} finally {
		await f.surface.dispose();
	}
	assert(f.pages.every((page) => page.closes === 1));
});

test("presentation stores bounds and optional viewport, while null only hides the existing page", async () => {
	const f = fixture();
	const bounds = { x: 600, y: 40, width: 500, height: 600 };
	try {
		await f.surface.present({ bounds, viewport: { width: 390, height: 844 } });
		assert.equal(f.pages.length, 0);
		assert.deepEqual((await f.surface.open({ url: "http://localhost:3000" })).viewport, {
			width: 390,
			height: 844,
		});
		const page = f.pages[0];
		assert(page);
		assert.deepEqual(page.presentations, [bounds]);
		await f.surface.present({ bounds: null });
		assert.equal(page.presentations.at(-1), null);
		assert.equal(page.closes, 0);
		assert.equal((await f.surface.state())?.url, "http://localhost:3000/");
		await f.surface.present({ bounds, viewport: { width: 1024, height: 768 } });
		assert.deepEqual((await f.surface.state())?.viewport, { width: 1024, height: 768 });
		assert.equal(f.pages.length, 1);
	} finally {
		await f.surface.dispose();
	}
});

test("history and reload delegate to the owned page and return its observed state", async () => {
	let back = 0;
	let forward = 0;
	let reload = 0;
	let index = 1;
	const urls = ["http://localhost:3000/one", "http://localhost:3000/two"] as const;
	const f = fixture((page) => {
		page.history = () => ({ canGoBack: index > 0, canGoForward: index < 1 });
		page.back = async () => {
			back++;
			index = 0;
			page.data.url = urls[0];
		};
		page.forward = async () => {
			forward++;
			index = 1;
			page.data.url = urls[1];
		};
		page.reload = async () => {
			reload++;
			page.data.title = "Reloaded by native page";
		};
	});
	try {
		const first = await f.surface.open({ url: urls[1] });
		assert.equal(first.canGoBack, true);
		assert.equal(first.canGoForward, false);
		const previous = await f.surface.command({ kind: "back" });
		assert.equal(previous.url, urls[0]);
		assert.equal(previous.canGoBack, false);
		assert.equal(previous.canGoForward, true);
		assert.equal((await f.surface.command({ kind: "forward" })).url, urls[1]);
		assert.equal((await f.surface.command({ kind: "reload" })).title, "Reloaded by native page");
		assert.deepEqual([back, forward, reload], [1, 1, 1]);
		assert.equal(f.pages.length, 1);
		assert.deepEqual(f.pages[0]?.loads, [urls[1]]);
	} finally {
		await f.surface.dispose();
	}
});

test("unsupported history stays disabled and rejected commands preserve the page", async () => {
	const f = fixture();
	try {
		await f.surface.open({ url: "http://localhost:3000/one" });
		await f.surface.open({ url: "http://localhost:3000/two" });
		for (const kind of ["back", "forward", "reload"] as const)
			await assert.rejects(f.surface.command({ kind }));
		const state = await f.surface.state();
		assert.equal(state?.canGoBack, false);
		assert.equal(state?.canGoForward, false);
		assert.equal(state?.url, "http://localhost:3000/two");
		assert.equal(f.pages[0]?.closes, 0);
		assert.equal(f.pages.length, 1);
	} finally {
		await f.surface.dispose();
	}
});

test("router validates inputs and outputs, rejects nonlocal URLs, and sanitizes adapter errors", async () => {
	const f = fixture();
	const caller = createLocalBrowserRouter(() => f.surface).createCaller({});
	try {
		assert.equal(await caller.state(), null);
		for (const url of [
			"https://localhost:3000/secret",
			"https://example.com/secret",
			"file:///secret",
			"http://user:secret@localhost:3000/",
			"http://localhost.evil/secret",
			"http://127.0.0.2/secret",
			"/relative-secret",
			"javascript:secret",
		]) {
			await assert.rejects(caller.open({ url }), (error: Error) => {
				assert(!error.message.includes("secret"));
				assert(!error.message.includes(url));
				return true;
			});
		}
		assert.equal(f.pages.length, 0);
		await assert.rejects(caller.present({ bounds: null, viewport: { width: 1, height: 1 } }));
		const state = await caller.open({ url: "http://localhost:3000" });
		assert.equal(state.provenance, "local-preview-unverified-revision");
		assert.equal(await caller.present({ bounds: null }), undefined);
		const page = f.pages[0];
		assert(page);
		page.onSnapshot = async () => {
			throw new Error("Credential secret at http://localhost:3000/private");
		};
		await assert.rejects(caller.state(), (error: Error) => {
			assert.equal(error.message, "Local browser operation failed");
			return true;
		});
		assert.equal(page.closes, 1);
		assert.equal(await caller.state(), null);
		assert.equal(await caller.close(), undefined);
	} finally {
		await f.surface.dispose();
	}
});

test("unexpected observed origin or credentials retire the page without exposing its URL", async () => {
	for (const url of [
		"http://localhost:3001/secret",
		"https://example.com/secret",
		"http://user:secret@localhost:3000/",
	]) {
		const f = fixture();
		try {
			await f.surface.open({ url: "http://localhost:3000/" });
			const page = f.pages[0];
			assert(page);
			page.data.url = url;
			await assert.rejects(f.surface.state(), { message: "Local browser operation failed" });
			assert.equal(page.closes, 1);
			assert.equal(await f.surface.state(), null);
		} finally {
			await f.surface.dispose();
		}
	}
});

test("operations serialize and the queue refuses excess polling work", async () => {
	const load = deferred<void>();
	const entered = deferred<void>();
	const f = fixture((page) => {
		page.onLoad = async () => {
			entered.resolve();
			await load.promise;
		};
	});
	try {
		const first = f.surface.open({ url: "http://localhost:3000/one" });
		await entered.promise;
		const next = f.surface.command({ kind: "navigate", url: "http://localhost:3000/two" });
		const polls = Array.from({ length: 30 }, () => f.surface.state());
		await assert.rejects(f.surface.state(), /queue is full/);
		assert.deepEqual(f.pages[0]?.loads, ["http://localhost:3000/one"]);
		load.resolve();
		assert.equal((await first).url, "http://localhost:3000/one");
		assert.equal((await next).url, "http://localhost:3000/two");
		assert((await Promise.all(polls)).every((state) => state?.url === "http://localhost:3000/two"));
	} finally {
		load.resolve();
		await f.surface.dispose();
	}
});

test("close cancels a late snapshot promptly and cannot retire or resurrect a newly opened page", async () => {
	const f = fixture();
	const snapshot = deferred<BrowserSnapshot>();
	const entered = deferred<void>();
	try {
		await f.surface.open({ url: "http://localhost:3000/old" });
		const old = f.pages[0];
		assert(old);
		old.onSnapshot = async () => {
			entered.resolve();
			return snapshot.promise;
		};
		const reading = assert.rejects(f.surface.state());
		await entered.promise;
		await promptly(f.surface.close());
		await promptly(reading);
		assert.equal(old.closes, 1);
		await promptly(f.surface.open({ url: "http://localhost:3000/new" }));
		snapshot.resolve({ ...old.data, url: "http://localhost:3000/late" });
		await delay(0);
		assert.equal((await f.surface.state())?.url, "http://localhost:3000/new");
		assert.equal(f.pages[1]?.closes, 0);
	} finally {
		snapshot.resolve({
			url: "http://localhost:3000/late",
			title: "Late",
			text: "",
			elements: [],
			scroll: { x: 0, y: 0 },
		});
		await f.surface.dispose();
	}
});

test("dispose aborts hung open and queued navigation; late load never reaches snapshot or presentation", async () => {
	const entered = deferred<void>();
	const loaded = deferred<void>();
	const f = fixture((page) => {
		page.onLoad = async () => {
			entered.resolve();
			await loaded.promise;
		};
	});
	const opening = assert.rejects(f.surface.open({ url: "http://localhost:3000/old" }));
	await entered.promise;
	const queued = assert.rejects(f.surface.open({ url: "http://localhost:3001/queued" }));
	await promptly(f.surface.dispose());
	await promptly(Promise.all([opening, queued]));
	assert.equal(f.pages.length, 1);
	assert.equal(f.pages[0]?.closes, 1);
	loaded.resolve();
	await delay(0);
	assert.equal(f.pages[0]?.snapshots, 0);
	await assert.rejects(f.surface.open({ url: "http://localhost:3000/new" }), /shut down/);
	await f.surface.dispose();
	assert.equal(f.pages[0]?.closes, 1);
});

test("deadline bounds a hung page operation and closes it without awaiting the adapter", async () => {
	const f = fixture((page) => {
		page.onLoad = () => new Promise<void>(() => {});
	}, 20);
	try {
		await promptly(assert.rejects(f.surface.open({ url: "http://localhost:3000/" })));
		assert.equal(f.pages[0]?.closes, 1);
		assert.equal(await f.surface.state(), null);
	} finally {
		await f.surface.dispose();
	}
});

test("a late viewport update cannot show a retired page or change a reopened surface", async () => {
	const f = fixture();
	const entered = deferred<void>();
	const resized = deferred<void>();
	try {
		await f.surface.open({ url: "http://localhost:3000/old" });
		const old = f.pages[0];
		assert(old);
		old.onViewport = async () => {
			entered.resolve();
			await resized.promise;
		};
		const presentation = assert.rejects(
			f.surface.present({
				bounds: { x: 0, y: 0, width: 390, height: 844 },
				viewport: { width: 390, height: 844 },
			})
		);
		await entered.promise;
		await promptly(f.surface.close());
		await promptly(presentation);
		await f.surface.open({ url: "http://localhost:3000/new" });
		resized.resolve();
		await delay(0);
		assert.deepEqual(old.presentations, [null]);
		assert.deepEqual((await f.surface.state())?.viewport, { width: 1024, height: 768 });
		assert.equal(f.pages[1]?.closes, 0);
	} finally {
		resized.resolve();
		await f.surface.dispose();
	}
});

test("modal hide bypasses slow page observation and fences an already queued show", async () => {
	const f = fixture();
	const entered = deferred<void>();
	const observed = deferred<BrowserSnapshot>();
	const bounds = { x: 600, y: 40, width: 500, height: 600 };
	try {
		await f.surface.open({ url: "http://localhost:3000/page" });
		await f.surface.present({ bounds });
		const page = f.pages[0];
		assert(page);
		page.onSnapshot = () => {
			entered.resolve();
			return observed.promise;
		};
		const polling = f.surface.state();
		await entered.promise;
		const queued = f.surface.present({ bounds: { ...bounds, width: 490 } });
		await promptly(f.surface.present({ bounds: null }));
		assert.equal(page.presentations.at(-1), null);
		observed.resolve(page.data);
		await polling;
		await queued;
		assert.equal(page.presentations.at(-1), null);
		assert.equal(page.closes, 0);
		page.onSnapshot = undefined;
		await f.surface.present({ bounds });
		assert.deepEqual(page.presentations.at(-1), bounds);
	} finally {
		observed.resolve(f.pages[0]?.data as BrowserSnapshot);
		await f.surface.dispose();
	}
});

test("a resize completing after modal hide cannot reveal the native page", async () => {
	const f = fixture();
	const entered = deferred<void>();
	const resized = deferred<void>();
	try {
		await f.surface.open({ url: "http://localhost:3000/page" });
		const page = f.pages[0];
		assert(page);
		page.onViewport = async () => {
			entered.resolve();
			await resized.promise;
		};
		const changing = f.surface.present({
			bounds: { x: 0, y: 0, width: 390, height: 844 },
			viewport: { width: 390, height: 844 },
		});
		await entered.promise;
		await promptly(f.surface.present({ bounds: null }));
		resized.resolve();
		await changing;
		assert.equal(page.presentations.at(-1), null);
		assert.deepEqual((await f.surface.state())?.viewport, { width: 390, height: 844 });
	} finally {
		resized.resolve();
		await f.surface.dispose();
	}
});
