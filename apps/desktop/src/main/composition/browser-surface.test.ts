import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
	BrowserBounds,
	BrowserCommand,
	BrowserElement,
	BrowserViewport,
	WorkspaceBrowserCommand,
} from "../../shared/contracts";
import type { BrowserPage, BrowserSnapshot } from "../runtime/browser";
import {
	BrowserOperationError,
	LocalBrowserSurface,
	createLocalBrowserRouter,
} from "./browser-surface";

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

type Snapshot = BrowserSnapshot & {
	documentId?: string;
	truncated?: boolean;
	viewport?: BrowserViewport;
};

/** Deliberately fake page: no Electron, server, browser launch or network in these tests. */
class FakePage implements BrowserPage {
	data: Snapshot = {
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
	onSnapshot?: () => Promise<Snapshot>;
	onAct?: (command: BrowserCommand, expected: BrowserSnapshot) => Promise<void>;
	actions: { command: BrowserCommand; expected: BrowserSnapshot }[] = [];
	presentation?: () => { visible: boolean; bounds: BrowserBounds | null };
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
	async act(command: BrowserCommand, expected: BrowserSnapshot) {
		assert.equal(this.closes, 0);
		this.actions.push({ command, expected });
		if (this.onAct) return this.onAct(command, expected);
		throw new Error("Surface must not invoke PR browser automation");
	}
	async viewport(value: BrowserViewport) {
		assert.equal(this.closes, 0);
		this.viewports.push(structuredClone(value));
		await this.onViewport?.();
		if (this.data.viewport) this.data.viewport = structuredClone(value);
	}
	present(value: BrowserBounds | null) {
		assert.equal(this.closes, 0);
		this.presentations.push(structuredClone(value));
	}
	close() {
		this.closes++;
	}
}
function fixture(
	configure: (page: FakePage) => void = () => {},
	timeoutMs = 1000,
	allowWebNavigation = false
) {
	const pages: FakePage[] = [];
	const origins: string[] = [];
	const surface = new LocalBrowserSurface({
		timeoutMs,
		allowWebNavigation,
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

function element(id = "actual-dom-ref"): BrowserElement {
	return {
		id,
		role: "textbox",
		name: "Name",
		tag: "input",
		value: "first",
		bounds: { x: 10, y: 20, width: 120, height: 40 },
		visible: true,
		enabled: true,
	};
}
function workspaceFixture(configure: (page: FakePage) => void = () => {}, timeoutMs = 1000) {
	return fixture(
		(page) => {
			page.data.documentId = "runtime-document-one";
			page.data.viewport = { width: 1024, height: 768 };
			page.data.elements = [element()];
			page.presentation = () => {
				const bounds = page.presentations.at(-1) ?? null;
				return { visible: bounds !== null, bounds };
			};
			page.onAct = async () => {};
			configure(page);
		},
		timeoutMs,
		true
	);
}
const visibleBounds = { x: 100, y: 0, width: 900, height: 700 };
function browserError(code: BrowserOperationError["code"]) {
	return (error: unknown) => {
		assert(error instanceof BrowserOperationError);
		assert.equal(error.code, code);
		assert.equal(error.recoverable, true);
		return true;
	};
}

test("workspace mode preserves one page and history across explicit and manual cross-origin navigation", async () => {
	let back = 0;
	let forward = 0;
	let reload = 0;
	const f = workspaceFixture((page) => {
		page.history = () => ({ canGoBack: true, canGoForward: true });
		page.back = async () => {
			back++;
			page.data.url = "https://first.example/";
		};
		page.forward = async () => {
			forward++;
			page.data.url = "https://second.example/";
		};
		page.reload = async () => {
			reload++;
			page.data.documentId = "runtime-reload";
		};
	});
	try {
		const initial = await f.surface.open({ url: "https://first.example/" });
		assert.equal(initial.provenance, "website-unverified-revision");
		const before = await f.surface.observe();
		await f.surface.command({ kind: "navigate", url: "https://second.example/next" });
		const page = f.pages[0];
		assert(page);
		page.data.url = "https://manual.example/from-user";
		assert.equal((await f.surface.state())?.url, page.data.url);
		const manual = await f.surface.observe();
		assert.equal(manual?.browserId, before?.browserId);
		assert.equal(manual?.url, page.data.url);
		assert.equal("commitSha" in (manual ?? {}), false);
		await f.surface.present({ bounds: visibleBounds });
		await f.surface.executeBrowser({ kind: "back" });
		await f.surface.executeBrowser({ kind: "forward" });
		const reloaded = await f.surface.executeBrowser({ kind: "reload" });
		assert.equal(reloaded.documentId, "runtime-reload");
		assert.deepEqual([back, forward, reload], [1, 1, 1]);
		const local = await f.surface.open({ url: "http://localhost:3000/" });
		assert.equal(local.provenance, "local-preview-unverified-revision");
		assert.equal(f.pages.length, 1);
		assert.equal(page.closes, 0);
		assert.deepEqual(page.loads, [
			"https://first.example/",
			"https://second.example/next",
			"http://localhost:3000/",
		]);
	} finally {
		await f.surface.dispose();
	}
});

test("workspace observation requires actual runtime identity and native presentation capability", async () => {
	const f = fixture();
	try {
		assert.equal(await f.surface.observe(), null);
		await f.surface.open({ url: "http://localhost:3000/" });
		const page = f.pages[0];
		assert(page);
		await assert.rejects(f.surface.observe(), browserError("UNSUPPORTED"));
		page.data.documentId = "runtime-supplied";
		await assert.rejects(f.surface.observe(), browserError("UNSUPPORTED"));
		page.presentation = () => ({ visible: false, bounds: null });
		assert.equal((await f.surface.observe())?.documentId, "runtime-supplied");
		assert.equal(page.closes, 0);
		assert.equal((await f.surface.state())?.provenance, "local-preview-unverified-revision");
	} finally {
		await f.surface.dispose();
	}
});

test("bounded actual observation strips code identity, keeps raw freshness, and reads snapshot only once", async () => {
	const f = workspaceFixture((page) => {
		page.data.text = "a".repeat(16001);
		page.data.elements = Array.from({ length: 151 }, (_, i) => ({
			...element(`dom-${i}`),
			value: "v".repeat(2001),
			location: {
				repository: "fixture-repo",
				revision: "head",
				commitSha: "a".repeat(40),
				path: "fake.ts",
				startLine: 1,
				endLine: 1,
			},
		}));
	});
	try {
		await f.surface.open({ url: "https://example.com/" });
		const page = f.pages[0];
		assert(page);
		const count = page.snapshots;
		const first = await f.surface.observe();
		assert(first);
		assert.equal(page.snapshots, count + 1);
		assert.equal(first.text.length, 16000);
		assert.equal(first.elements.length, 150);
		assert.equal(first.elements[0]?.value?.length, 2000);
		assert.equal("location" in (first.elements[0] ?? {}), false);
		assert.equal(first.truncated, true);
		assert.equal(first.provenance, "website-unverified-revision");
		assert.equal(Number.isNaN(Date.parse(first.observedAt)), false);
		assert.equal(first.browserId.length, 36);
		assert.equal((await f.surface.observe())?.sequence, first.sequence);
		page.data.text = `${"a".repeat(16000)}b`;
		const rawText = await f.surface.observe();
		assert.equal(rawText?.text, first.text);
		assert.equal(rawText?.sequence, first.sequence + 1);
		const input = page.data.elements[0];
		assert(input);
		input.value = `${"v".repeat(2000)}b`;
		const rawValue = await f.surface.observe();
		assert.equal(rawValue?.elements[0]?.value, first.elements[0]?.value);
		assert.equal(rawValue?.sequence, first.sequence + 2);
	} finally {
		await f.surface.dispose();
	}
});

test("DOM sequence tracks documents, URLs, title, text, refs, scroll and viewport but excludes presentation", async () => {
	const f = workspaceFixture();
	try {
		await f.surface.open({ url: "https://example.com/" });
		// Fix the viewport explicitly: changing only native presentation must not stale DOM refs.
		await f.surface.present({ bounds: null, viewport: { width: 1000, height: 700 } });
		const page = f.pages[0];
		assert(page);
		const first = await f.surface.observe();
		assert(first);
		await f.surface.present({ bounds: visibleBounds });
		const shown = await f.surface.observe();
		assert.equal(shown?.presented, true);
		assert.equal(shown?.sequence, first.sequence);
		await f.surface.present({ bounds: { ...visibleBounds, width: 800 } });
		await f.surface.present({ bounds: null });
		assert.equal((await f.surface.observe())?.sequence, first.sequence);
		// Native visibility is authoritative even when the service has remembered show bounds.
		await f.surface.present({ bounds: visibleBounds });
		page.presentation = () => ({ visible: false, bounds: visibleBounds });
		assert.equal((await f.surface.observe())?.presented, false);
		const changes = [
			() => {
				page.data.documentId = "runtime-document-two";
			},
			() => {
				page.data.url = "https://other.example/";
			},
			() => {
				page.data.title = "New title";
			},
			() => {
				page.data.text = "New text";
			},
			() => {
				page.data.elements = [element("new-actual-ref")];
			},
			() => {
				page.data.scroll = { x: 1, y: 30 };
			},
			() => {
				page.data.viewport = { width: 390, height: 844 };
			},
		];
		for (const [i, change] of changes.entries()) {
			change();
			const next = await f.surface.observe();
			assert.equal(next?.sequence, first.sequence + i + 1);
			assert.equal((await f.surface.observe())?.sequence, next?.sequence);
		}
		assert.deepEqual((await f.surface.observe())?.viewport, { width: 390, height: 844 });
	} finally {
		await f.surface.dispose();
	}
});

test("workspace actions refresh before mutation, reuse actual refs and exact snapshot, then observe the result", async () => {
	const f = workspaceFixture();
	try {
		await f.surface.open({ url: "https://example.com/" });
		await f.surface.present({ bounds: visibleBounds });
		const page = f.pages[0];
		assert(page);
		let before = await f.surface.observe();
		assert(before);
		let exact: BrowserSnapshot | undefined;
		page.onSnapshot = async () => {
			exact = structuredClone(page.data);
			return exact;
		};
		page.onAct = async (command, expected) => {
			assert.equal(expected, exact);
			assert.equal((expected as Snapshot).documentId, "runtime-document-one");
			assert.equal(command.sessionId, "conversation-session");
			assert.equal(command.requestId, "effect-request");
			if (command.kind === "type") {
				const target = page.data.elements.find((item) => item.id === command.elementId);
				assert(target);
				target.value = command.text;
			} else if (command.kind === "scroll") page.data.scroll.y = command.y ?? 50;
			else page.data.text = "Clicked actual page";
		};
		for (const kind of ["click", "type", "scroll"] as const) {
			const snapshots: number = page.snapshots;
			const target = {
				browserId: before.browserId,
				observationSequence: before.sequence,
				elementId: "actual-dom-ref",
			};
			const command: WorkspaceBrowserCommand =
				kind === "type"
					? { ...target, kind, text: "typed text" }
					: kind === "scroll"
						? { ...target, kind, y: 80 }
						: { ...target, kind };
			const next = await f.surface.executeBrowser(command, undefined, {
				sessionId: "conversation-session",
				requestId: "effect-request",
			});
			assert.equal(page.snapshots, snapshots + 2);
			const applied: BrowserCommand | undefined = page.actions.at(-1)?.command;
			assert(applied && "elementId" in applied);
			assert.equal(applied.elementId, "actual-dom-ref");
			assert.equal(next.sequence, before.sequence + 1);
			before = next;
		}
		const resized = await f.surface.executeBrowser({
			kind: "viewport",
			viewport: { width: 390, height: 844 },
		});
		assert.deepEqual(resized.viewport, { width: 390, height: 844 });
		assert.equal(resized.sequence, before.sequence + 1);
		assert.equal(page.actions.length, 3);
		assert.equal(page.closes, 0);
	} finally {
		await f.surface.dispose();
	}
});

test("stale document, wrong browser, unknown refs and hidden page reject recoverably without mutation", async () => {
	const f = workspaceFixture();
	try {
		await f.surface.open({ url: "https://example.com/" });
		await f.surface.present({ bounds: visibleBounds });
		const page = f.pages[0];
		assert(page);
		const initial = await f.surface.observe();
		assert(initial);
		const click = {
			kind: "click" as const,
			browserId: initial.browserId,
			observationSequence: initial.sequence,
			elementId: "actual-dom-ref",
		};
		await assert.rejects(
			f.surface.executeBrowser({ ...click, browserId: "other-browser" }),
			browserError("BROWSER_MISMATCH")
		);
		await assert.rejects(
			f.surface.executeBrowser({ ...click, elementId: "fabricated-selector" }),
			browserError("INVALID_ELEMENT")
		);
		page.data.documentId = "runtime-reloaded-identical-content";
		await assert.rejects(f.surface.executeBrowser(click), browserError("STALE_OBSERVATION"));
		const current = await f.surface.observe();
		assert(current);
		await f.surface.present({ bounds: null });
		await assert.rejects(
			f.surface.executeBrowser({ ...click, observationSequence: current.sequence }),
			browserError("BROWSER_NOT_PRESENTED")
		);
		await assert.rejects(
			f.surface.executeBrowser({ kind: "viewport", viewport: { width: 390, height: 844 } }),
			browserError("BROWSER_NOT_PRESENTED")
		);
		await f.surface.present({ bounds: visibleBounds });
		await assert.rejects(
			f.surface.executeBrowser({
				kind: "scroll",
				browserId: current.browserId,
				observationSequence: current.sequence,
			}),
			browserError("INVALID_COMMAND")
		);
		await assert.rejects(f.surface.executeBrowser({ kind: "back" }), browserError("UNSUPPORTED"));
		assert.equal(page.actions.length, 0);
		assert.equal(page.closes, 0);
		assert.equal((await f.surface.state())?.url, "https://example.com/");
	} finally {
		await f.surface.dispose();
	}
});

test("runtime DOM guard races are recoverable; unexpected adapter errors remain sanitized", async () => {
	const f = workspaceFixture();
	try {
		await f.surface.open({ url: "https://example.com/" });
		await f.surface.present({ bounds: visibleBounds });
		const page = f.pages[0];
		assert(page);
		const before = await f.surface.observe();
		assert(before);
		const click = {
			kind: "click" as const,
			browserId: before.browserId,
			observationSequence: before.sequence,
			elementId: "actual-dom-ref",
		};
		for (const message of [
			"Browser observation changed before action",
			"Stale browser element",
			"Browser element is obscured",
			"Browser element is not an editable text field",
		]) {
			page.onAct = async () => {
				throw new Error(message);
			};
			await assert.rejects(
				f.surface.executeBrowser(click),
				browserError(
					message.includes("observation") || message.startsWith("Stale")
						? "STALE_OBSERVATION"
						: "INVALID_ELEMENT"
				)
			);
			assert.equal(page.closes, 0);
		}
		page.onAct = async () => {
			throw new Error("secret adapter credentials");
		};
		await assert.rejects(f.surface.executeBrowser(click), {
			message: "Local browser operation failed",
		});
		assert.equal(page.closes, 1);
		assert.equal(await f.surface.observe(), null);
	} finally {
		await f.surface.dispose();
	}
});

test("caller abort drops queued open, navigation and workspace actions without admitting them", async () => {
	const f = workspaceFixture();
	const blocked = deferred<Snapshot>();
	const entered = deferred<void>();
	try {
		const cancelled = new AbortController();
		cancelled.abort();
		await assert.rejects(
			f.surface.open({ url: "https://never.example/" }, cancelled.signal),
			browserError("CANCELLED")
		);
		assert.equal(f.pages.length, 0);
		await f.surface.open({ url: "https://example.com/" });
		await f.surface.present({ bounds: visibleBounds });
		const page = f.pages[0];
		assert(page);
		page.onSnapshot = async () => {
			entered.resolve();
			return blocked.promise;
		};
		const observing = f.surface.observe();
		await entered.promise;
		const abort = new AbortController();
		const work = [
			f.surface.open({ url: "https://queued.example/" }, abort.signal),
			f.surface.command({ kind: "navigate", url: "https://also-queued.example/" }, abort.signal),
			f.surface.executeBrowser(
				{ kind: "viewport", viewport: { width: 390, height: 844 } },
				abort.signal
			),
		];
		const rejected = work.map((promise) => assert.rejects(promise, browserError("CANCELLED")));
		abort.abort();
		await promptly(Promise.all(rejected));
		blocked.resolve(page.data);
		await observing;
		page.onSnapshot = undefined;
		assert.equal((await f.surface.observe())?.url, "https://example.com/");
		assert.deepEqual(page.loads, ["https://example.com/"]);
		assert.equal(page.actions.length, 0);
		assert.equal(page.closes, 0);
	} finally {
		blocked.resolve(f.pages[0]?.data as Snapshot);
		await f.surface.dispose();
	}
});

test("caller cancellation rejects admitted action promptly, preserves healthy page and serializes its late completion", async () => {
	const f = workspaceFixture();
	const entered = deferred<void>();
	const acted = deferred<void>();
	try {
		await f.surface.open({ url: "https://example.com/" });
		await f.surface.present({ bounds: visibleBounds });
		const page = f.pages[0];
		assert(page);
		const before = await f.surface.observe();
		assert(before);
		page.onAct = async () => {
			entered.resolve();
			await acted.promise;
			page.data.text = "Actual late result";
		};
		const abort = new AbortController();
		const rejected = assert.rejects(
			f.surface.executeBrowser(
				{
					kind: "click",
					browserId: before.browserId,
					observationSequence: before.sequence,
					elementId: "actual-dom-ref",
				},
				abort.signal
			),
			browserError("CANCELLED")
		);
		await entered.promise;
		abort.abort();
		await promptly(rejected);
		assert.equal(page.closes, 0);
		const snapshotCount = page.snapshots;
		const next = f.surface.observe();
		await delay(0);
		assert.equal(page.snapshots, snapshotCount);
		acted.resolve();
		const current = await next;
		assert.equal(current?.text, "Actual late result");
		assert.equal(
			page.snapshots,
			snapshotCount + 1,
			"cancelled action must not publish a late observation"
		);
		assert.equal(current?.browserId, before.browserId);
		assert.equal(page.closes, 0);
	} finally {
		acted.resolve();
		await f.surface.dispose();
	}
});

test("cancelled admitted navigation retains page after load; an abandoned hung operation still expires", async () => {
	const f = workspaceFixture();
	const entered = deferred<void>();
	const loaded = deferred<void>();
	try {
		await f.surface.open({ url: "https://example.com/" });
		const page = f.pages[0];
		assert(page);
		page.onLoad = async () => {
			entered.resolve();
			await loaded.promise;
		};
		const abort = new AbortController();
		const rejected = assert.rejects(
			f.surface.command({ kind: "navigate", url: "https://other.example/" }, abort.signal),
			browserError("CANCELLED")
		);
		await entered.promise;
		abort.abort();
		await promptly(rejected);
		const count = page.snapshots;
		loaded.resolve();
		assert.equal((await f.surface.observe())?.url, "https://other.example/");
		assert.equal(page.snapshots, count + 1);
		assert.equal(page.closes, 0);
	} finally {
		loaded.resolve();
		await f.surface.dispose();
	}
	const hung = workspaceFixture((page) => {
		page.onLoad = () => new Promise(() => {});
	}, 30);
	try {
		const abort = new AbortController();
		const rejected = assert.rejects(
			hung.surface.open({ url: "https://example.com/" }, abort.signal),
			browserError("CANCELLED")
		);
		await delay(0);
		abort.abort();
		await promptly(rejected);
		assert.equal(hung.pages[0]?.closes, 0);
		await delay(50);
		assert.equal(hung.pages[0]?.closes, 1);
		assert.equal(await hung.surface.observe(), null);
	} finally {
		await hung.surface.dispose();
	}
});

test("workspace close retires lifetime identity and late rejected work cannot destroy a reopened page", async () => {
	const f = workspaceFixture();
	const entered = deferred<void>();
	const late = deferred<void>();
	try {
		await f.surface.open({ url: "https://example.com/" });
		await f.surface.present({ bounds: visibleBounds });
		const old = f.pages[0];
		assert(old);
		const before = await f.surface.observe();
		assert(before);
		old.onAct = async () => {
			entered.resolve();
			await late.promise;
			throw new Error("late adapter failure");
		};
		const rejected = assert.rejects(
			f.surface.executeBrowser({
				kind: "click",
				browserId: before.browserId,
				observationSequence: before.sequence,
				elementId: "actual-dom-ref",
			})
		);
		await entered.promise;
		await promptly(f.surface.close());
		await promptly(rejected);
		await f.surface.open({ url: "https://example.com/new" });
		const current = await f.surface.observe();
		assert(current);
		assert.notEqual(current.browserId, before.browserId);
		late.resolve();
		await delay(0);
		assert.equal((await f.surface.observe())?.browserId, current.browserId);
		assert.equal(f.pages[1]?.closes, 0);
		assert.equal(old.closes, 1);
	} finally {
		late.resolve();
		await f.surface.dispose();
	}
});

test("cancelled admitted resize retains acknowledged native viewport without publishing a late result", async () => {
	const f = workspaceFixture();
	const entered = deferred<void>();
	const resized = deferred<void>();
	try {
		await f.surface.open({ url: "https://example.com/" });
		await f.surface.present({ bounds: visibleBounds });
		const page = f.pages[0];
		assert(page);
		// Exercise the compatible runtime shape that reports document identity but no viewport.
		page.data.viewport = undefined;
		page.onViewport = async () => {
			entered.resolve();
			await resized.promise;
		};
		const abort = new AbortController();
		const rejected = assert.rejects(
			f.surface.executeBrowser(
				{ kind: "viewport", viewport: { width: 390, height: 844 } },
				abort.signal
			),
			browserError("CANCELLED")
		);
		await entered.promise;
		abort.abort();
		await promptly(rejected);
		const snapshots = page.snapshots;
		resized.resolve();
		const current = await f.surface.observe();
		assert.deepEqual(current?.viewport, { width: 390, height: 844 });
		assert.equal(page.snapshots, snapshots + 1);
		assert.equal(page.closes, 0);
	} finally {
		resized.resolve();
		await f.surface.dispose();
	}
});

test("runtime truncation is retained and equivalent snapshot field ordering keeps DOM sequence stable", async () => {
	const f = workspaceFixture();
	try {
		await f.surface.open({ url: "https://example.com/" });
		const first = await f.surface.observe();
		assert(first);
		const page = f.pages[0];
		assert(page);
		const original = page.data.elements[0];
		assert(original);
		page.data.elements = [
			{
				enabled: original.enabled,
				visible: original.visible,
				bounds: {
					height: original.bounds.height,
					width: original.bounds.width,
					y: original.bounds.y,
					x: original.bounds.x,
				},
				value: original.value,
				tag: original.tag,
				name: original.name,
				role: original.role,
				id: original.id,
			},
		];
		page.data.truncated = true;
		const current = await f.surface.observe();
		assert.equal(current?.truncated, true);
		assert.equal(current?.sequence, first.sequence);
		assert.equal((await f.surface.state())?.url, "https://example.com/");
		assert.equal((await f.surface.observe())?.sequence, first.sequence);
	} finally {
		await f.surface.dispose();
	}
});

test("web mode still retires unsafe observed URLs without reflecting page content", async () => {
	for (const url of [
		"file:///secret",
		"http://public.example/secret",
		"https://user:secret@example.com/",
	]) {
		const f = workspaceFixture();
		try {
			await f.surface.open({ url: "https://example.com/" });
			const page = f.pages[0];
			assert(page);
			page.data.url = url;
			await assert.rejects(f.surface.observe(), { message: "Local browser operation failed" });
			assert.equal(page.closes, 1);
			assert.equal(await f.surface.observe(), null);
		} finally {
			await f.surface.dispose();
		}
	}
});

test("desktop tracks pane bounds and refreshes observed DOM identity while phone retains its explicit viewport", async () => {
	const f = workspaceFixture();
	try {
		await f.surface.open({ url: "https://example.com/" });
		assert.equal((await f.surface.state())?.viewportMode, "desktop");
		await f.surface.present({ bounds: { x: 20, y: 80, width: 1300, height: 850 } });
		const first = await f.surface.observe();
		assert.ok(first);
		assert.deepEqual(first.viewport, { width: 1300, height: 850 });
		await f.surface.present({ bounds: { x: 420, y: 80, width: 880, height: 650 } });
		const resized = await f.surface.observe();
		assert.ok(resized);
		assert.equal(resized.browserId, first.browserId);
		assert.deepEqual(resized.viewport, { width: 880, height: 650 });
		assert.equal(resized.sequence, first.sequence + 1);
		await f.surface.executeBrowser({ kind: "viewport", viewport: { width: 390, height: 844 } });
		await f.surface.present({ bounds: { x: 20, y: 80, width: 1200, height: 900 } });
		assert.deepEqual((await f.surface.state())?.viewport, { width: 390, height: 844 });
		assert.equal((await f.surface.state())?.viewportMode, "phone");
		await f.surface.executeBrowser({ kind: "viewport", viewport: { width: 1024, height: 768 } });
		assert.deepEqual((await f.surface.state())?.viewport, { width: 1200, height: 900 });
		assert.equal((await f.surface.state())?.viewportMode, "desktop");
		assert.equal((await f.surface.observe())?.browserId, first.browserId);
		assert.equal(f.pages.length, 1);
	} finally {
		await f.surface.dispose();
	}
});
