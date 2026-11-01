// Controlled DOM probe, not a browser. Exercises the actual page mount and events.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = __dirname;
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const { FocusDemo, scenes, mount } = require("./site.js");

class Node {
	constructor(attrs = {}) {
		this.attrs = attrs;
		this.dataset = {};
		this.events = {};
		this.children = [];
		this.textContent = "";
		this.hidden = "hidden" in attrs;
		this.tabIndex = Number(attrs.tabindex || 0);
		this.offsetWidth = 700;
		for (const [key, value] of Object.entries(attrs))
			if (key.startsWith("data-")) this.dataset[key.slice(5)] = value;
		const classes = new Set((attrs.class || "").split(" "));
		this.classList = {
			toggle: (key, force) => {
				const enabled = force === undefined ? !classes.has(key) : force;
				enabled ? classes.add(key) : classes.delete(key);
				return enabled;
			},
			add: (key) => classes.add(key),
			remove: (key) => classes.delete(key),
			contains: (key) => classes.has(key),
		};
	}
	setAttribute(key, value) {
		this.attrs[key] = value;
	}
	addEventListener(key, callback) {
		this.events[key] ||= [];
		this.events[key].push(callback);
	}
	fire(key, event = {}) {
		for (const callback of this.events[key] || []) callback.call(this, event);
	}
	append(...nodes) {
		this.children.push(...nodes);
	}
	replaceChildren(...nodes) {
		this.children = nodes;
	}
	focus() {
		this.focused = true;
	}
}
const nodes = [];
for (const match of html.matchAll(/<[a-z][a-z0-9-]*\b([^>]+)>/gi)) {
	const attrs = {};
	for (const attribute of match[1].matchAll(/([a-z][a-z0-9-]*)(?:="([^"]*)")?/gi))
		attrs[attribute[1]] = attribute[2] ?? "";
	nodes.push(new Node(attrs));
}
const byId = (id) => nodes.find((node) => node.attrs.id === id);
const doc = {
	body: new Node(),
	getElementById: byId,
	createElement: () => new Node(),
	querySelectorAll(selector) {
		const name = selector.slice(1, -1);
		return nodes.filter((node) => name in node.attrs);
	},
};
let advances = 0;
let markPaused = false;
const win = {
	matchMedia: () => ({ matches: false }),
	scrollY: 0,
	setTimeout: () => 1,
	clearTimeout: () => {},
	requestAnimationFrame: (callback) => {
		callback();
		return 1;
	},
	addEventListener: () => {},
	PullForwardController: class {
		advance() {
			advances++;
		}
		pause() {
			markPaused = true;
		}
		resume() {
			markPaused = false;
		}
	},
};
const mounted = mount(doc, win);
assert(mounted);
assert.equal(byId("scene-title").textContent, scenes[0].title);
assert.equal(byId("scene-code").children.length, scenes[0].lines.length);
byId("tab-discuss").fire("click");
assert.equal(byId("panel-change").hidden, true);
assert.equal(byId("panel-discuss").hidden, false);
assert.equal(byId("tab-discuss").attrs["aria-selected"], "true");
assert.equal(byId("scene-answer").textContent, scenes[0].answer);
let prevented = false;
byId("tab-discuss").fire("keydown", {
	key: "ArrowLeft",
	preventDefault() {
		prevented = true;
	},
});
assert(prevented);
assert.equal(byId("panel-change").hidden, false);
assert(byId("tab-change").focused);
byId("revise-button").fire("click");
assert.equal(byId("revision-note").hidden, false);
assert.equal(byId("revision-note").textContent, scenes[0].revision);
byId("next-button").fire("click");
assert.equal(mounted.demo.state().index, 1);
assert.equal(byId("scene-title").textContent, scenes[1].title);
assert.equal(byId("revision-note").hidden, true);
assert.equal(byId("scene-file").textContent, scenes[1].file);
assert.equal(byId("scene-code").children.length, scenes[1].lines.length);
assert.equal(
	byId("demo-announcement").textContent,
	"Empty states is now in focus. Work in progress."
);
const itemButtons = doc.querySelectorAll("[data-item]");
itemButtons[2].fire("click");
assert.equal(byId("scene-title").textContent, scenes[2].title);
assert.equal(itemButtons[2].attrs["aria-pressed"], "true");
assert.equal(itemButtons[0].attrs["aria-pressed"], "false");
byId("next-button").fire("click");
assert.equal(mounted.demo.state().index, 0);
assert.equal(advances, 3);
doc.querySelectorAll("[data-open-discussion]")[0].fire("click");
assert.equal(byId("panel-discuss").hidden, false);
byId("motion-toggle").fire("click");
assert.equal(markPaused, true);
assert.equal(byId("motion-toggle").attrs["aria-pressed"], "true");
byId("motion-toggle").fire("click");
assert.equal(markPaused, false);
const demo = new FocusDemo();
assert.equal(demo.select(-1), false);
assert.equal(demo.select(3), false);
assert.equal(demo.select(0.5), false);
assert.equal(demo.setTab("other"), false);
assert.equal(demo.state().index, 0);

// Site must use exact frozen assets; original kit remains untouched.
const kit = path.resolve(root, "../../design/muse-logo/v3/pull-forward");
for (const [original, copy] of [
	["motion/pull-forward.js", "pull-forward.js"],
	["motion/controller.js", "controller.js"],
	["motion/pull-forward.css", "pull-forward.css"],
	["svg/pull-forward.svg", "pull-forward.svg"],
	["svg/ui/pull-forward-32-dark.svg", "mark-small.svg"],
	["png/transparent/pull-forward-512.png", "pull-forward.png"],
])
	assert(
		fs
			.readFileSync(path.join(kit, original))
			.equals(fs.readFileSync(path.join(root, "assets", copy))),
		copy
	);

console.log(
	"PASS: actual mount, item selection, 3-item loop, discussion content, keyboard tabs, revision reset, live status, motion controls, invalid inputs, frozen brand bytes."
);

// Static publication checks: no browser, server, build or provider access.
const design = path.resolve(root, "../../design/muse-logo/v3/musefocus-site/dist");
for (const name of fs.readdirSync(path.join(design, "assets"))) {
	assert(
		fs
			.readFileSync(path.join(design, "assets", name))
			.equals(fs.readFileSync(path.join(root, "assets", name))),
		`Frozen asset changed: ${name}`
	);
}
assert(
	fs
		.readFileSync(path.join(design, "styles.css"))
		.equals(fs.readFileSync(path.join(root, "focus.css")))
);
const ids = nodes.filter((node) => node.attrs.id).map((node) => node.attrs.id);
assert.equal(new Set(ids).size, ids.length, "Duplicate page ID");
for (const node of nodes) {
	for (const target of (node.attrs["aria-controls"] || "").split(" ").filter(Boolean)) {
		assert(ids.includes(target), `Missing control target: ${target}`);
	}
	if (node.attrs.href?.startsWith("#")) {
		assert(ids.includes(node.attrs.href.slice(1)), `Missing anchor: ${node.attrs.href}`);
	}
	for (const key of ["src", "href"]) {
		const target = node.attrs[key];
		if (!target || target.startsWith("#")) continue;
		assert(!/^(?:https?:|\/\/|data:)/.test(target), `Unexpected remote reference: ${target}`);
		assert(fs.statSync(path.join(root, target)).isFile(), `Missing file: ${target}`);
	}
}
for (const image of html.matchAll(/<img\b([^>]+)>/g)) {
	assert(/\balt="[^"]*"/.test(image[1]), "Missing image alternative");
}
const social = html.match(/property="og:image" content="([^"]+)"/)[1];
assert(fs.statSync(path.join(root, social)).isFile());
for (const css of ["focus.css", "assets/pull-forward.css"]) {
	for (const match of fs
		.readFileSync(path.join(root, css), "utf8")
		.matchAll(/url\(['"]?([^)'"\s]+)/g)) {
		assert(fs.statSync(path.resolve(root, path.dirname(css), match[1])).isFile(), match[1]);
	}
}
for (const script of ["site.js", "assets/controller.js", "assets/pull-forward.js"]) {
	assert(
		!/getUserMedia|\bfetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sendBeacon/.test(
			fs.readFileSync(path.join(root, script), "utf8")
		),
		`Unexpected network/media/storage call: ${script}`
	);
}
assert.equal(nodes.filter((node) => node.attrs.href === "setup.html").length, 2);
assert(html.includes("Signed download pending"));
assert(html.includes("Interactive product illustration"));
assert(!/releases\/latest|sign.?up|waitlist/i.test(html));
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "launch.json"), "utf8")), {
	videoUrl: null,
	releaseReady: false,
	repositoryPublic: false,
});
const desktop = path.resolve(root, "../desktop");
assert(
	fs
		.readFileSync(path.join(kit, "icons/macos/PullForward.icns"))
		.equals(fs.readFileSync(path.join(desktop, "resources/icon.icns")))
);
assert(
	/^mac:\n {2}icon: resources\/icon.icns$/m.test(
		fs.readFileSync(path.join(desktop, "electron-builder.yml"), "utf8")
	)
);
console.log(
	"PASS: local references, CSS fonts, page IDs/targets, image alternatives, setup links, pending release metadata, no remote/media calls, every frozen asset and selected mac.icon."
);
