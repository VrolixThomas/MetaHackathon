/* All examples are local illustration data. No microphone, model or source calls. */
((root, factory) => {
	const api = factory();
	if (typeof module !== "undefined" && module.exports) module.exports = api;
	else root.MuseFocusDemo = api;
	if (typeof document !== "undefined") api.mount(document, root);
})(typeof globalThis === "undefined" ? this : globalThis, () => {
	const scenes = [
		{
			name: "Session recovery",
			kind: "Review",
			eyebrow: "Your review is the next step",
			title: "Pick up where you left off.",
			description:
				"A proposal to remember where a review stopped, so you can return to the same place. Start with the change, or talk through the tradeoff.",
			file: "session-state.ts",
			lines: [
				[12, " type ReviewSession = {"],
				[13, "   repository: string;"],
				[14, "-  currentFile?: string;", "removed"],
				[14, "+  checkpoint?: {", "added"],
				[15, "+    file: string;", "added"],
				[16, "+    position: number;", "added"],
				[17, "+  };", "added"],
				[18, " };"],
			],
			note: "The question for you: what should happen if the file has changed since the checkpoint?",
			question: "“What happens if the file changed while I was away?”",
			answer:
				"A useful next step would be to compare the checkpoint with the current file, then choose a safe place to resume. Would you want the app to ask first?",
			revision:
				"Example revision: ask before resuming when the source has changed. In the app, a revision would go back to the worker with your direction.",
		},
		{
			name: "Empty states",
			kind: "Work in progress",
			eyebrow: "A first pass, ready for a closer look",
			title: "Make the first step obvious.",
			description:
				"An early copy change for an empty review queue. You can inspect the direction while the broader task is still in progress.",
			file: "review-empty-state.ts",
			lines: [
				[8, " const emptyState = {"],
				[9, '-  title: "No data found",', "removed"],
				[9, '+  title: "A clear place to start",', "added"],
				[10, '+  body: "Choose a repository to review.",', "added"],
				[11, '+  action: "Choose a repository",', "added"],
				[12, " };"],
			],
			note: "The question for you: is the next action clear before a repository is connected?",
			question: "“Is this the right message for someone opening the app for the first time?”",
			answer:
				"The copy should match what the person can do next. We could separate a first-time setup state from a genuinely empty queue, then give each one a clear action.",
			revision:
				"Example revision: use separate copy for first-time setup and an empty queue. In the app, this direction would become a bounded follow-up for the worker.",
		},
		{
			name: "Search filters",
			kind: "Decision",
			eyebrow: "A tradeoff worth your attention",
			title: "Keep the useful things close.",
			description:
				"A proposal to retain your filters when you return to a review. Decide what should persist, and what should reset with a new source.",
			file: "review-filters.ts",
			lines: [
				[21, " function openReview(reviewId: string) {"],
				[22, "-  resetFilters();", "removed"],
				[22, "+  const saved = filtersFor(reviewId);", "added"],
				[23, "+  applyFilters(saved ?? defaultFilters);", "added"],
				[24, "   showReview(reviewId);"],
				[25, " }"],
			],
			note: "The question for you: should filters follow the review, the repository, or the person?",
			question: "“Would keeping the old filters hide something I need to see?”",
			answer:
				"That is the main tradeoff. A visible filter summary and a clear reset action could preserve your context while making it obvious when a view is filtered.",
			revision:
				"Example revision: keep filters per review and always show an active-filter summary. In the app, you would review the resulting change before accepting it.",
		},
	];

	class FocusDemo {
		constructor(onChange = () => {}) {
			this.index = 0;
			this.tab = "change";
			this.revised = false;
			this.onChange = onChange;
		}
		state() {
			return { index: this.index, tab: this.tab, revised: this.revised, scene: scenes[this.index] };
		}
		emit() {
			this.onChange(this.state());
			return this.state();
		}
		select(index) {
			if (!Number.isInteger(index) || index < 0 || index >= scenes.length) return false;
			this.index = index;
			this.tab = "change";
			this.revised = false;
			this.emit();
			return true;
		}
		next() {
			this.select((this.index + 1) % scenes.length);
			return this.state();
		}
		setTab(tab) {
			if (tab !== "change" && tab !== "discuss") return false;
			this.tab = tab;
			this.emit();
			return true;
		}
		revise() {
			this.revised = !this.revised;
			return this.emit();
		}
	}

	function mount(doc, win) {
		const byId = (id) => doc.getElementById(id);
		if (!byId("focus-workspace")) return null;
		const tabs = Array.from(doc.querySelectorAll("[data-tab]"));
		const items = Array.from(doc.querySelectorAll("[data-item]"));
		const media = win.matchMedia("(prefers-reduced-motion: reduce)");
		let mark = null;
		let paused = false;
		let previousIndex = 0;
		let firstRender = true;
		let settleTimer = null;
		if (typeof win.PullForwardController === "function") {
			mark = new win.PullForwardController(byId("hero-mark"), {
				size: 120,
				theme: "dark",
				backgroundMotion: true,
				decorative: true,
			});
		}
		const demo = new FocusDemo((state) => {
			const scene = state.scene;
			const text = {
				"scene-kind": scene.kind,
				"scene-count": `${String(state.index + 1).padStart(2, "0")} / 03`,
				"scene-eyebrow": scene.eyebrow,
				"scene-title": scene.title,
				"scene-description": scene.description,
				"scene-file": scene.file,
				"scene-note": scene.note,
				"scene-question": scene.question,
				"scene-answer": scene.answer,
			};
			for (const id of Object.keys(text)) {
				byId(id).textContent = text[id];
			}
			for (const [index, item] of items.entries()) {
				item.classList.toggle("is-selected", state.index === index);
				item.setAttribute("aria-pressed", String(state.index === index));
			}
			for (const tab of tabs) {
				const active = tab.dataset.tab === state.tab;
				tab.setAttribute("aria-selected", String(active));
				tab.tabIndex = active ? 0 : -1;
			}
			byId("panel-change").hidden = state.tab !== "change";
			byId("panel-discuss").hidden = state.tab !== "discuss";
			byId("revision-note").hidden = !state.revised;
			byId("revision-note").textContent = state.revised ? scene.revision : "";
			byId("revise-label").textContent = state.revised
				? "Close revision example"
				: "Explore a revision";
			byId("revise-button").setAttribute("aria-expanded", String(state.revised));
			byId("scene-code").replaceChildren();
			for (const line of scene.lines) {
				const row = doc.createElement("code");
				row.className = `code-line${line[2] ? ` ${line[2]}` : ""}`;
				const number = doc.createElement("span");
				number.className = "line-number";
				number.textContent = line[0];
				const code = doc.createElement("span");
				code.textContent = line[1];
				row.append(number, code);
				byId("scene-code").append(row);
			}
			if (!firstRender && previousIndex !== state.index) {
				if (mark) mark.advance();
				byId("demo-announcement").textContent = `${scene.name} is now in focus. ${scene.kind}.`;
				if (!media.matches && !paused) {
					const workspace = byId("focus-workspace");
					workspace.classList.remove("is-changing");
					// A single intentional reflow restarts the brief settling animation.
					void workspace.offsetWidth;
					workspace.classList.add("is-changing");
					win.clearTimeout(settleTimer);
					settleTimer = win.setTimeout(() => workspace.classList.remove("is-changing"), 500);
				}
			}
			previousIndex = state.index;
			firstRender = false;
		});
		for (const item of items) {
			item.addEventListener("click", () => demo.select(Number(item.dataset.item)));
		}
		for (const tab of tabs) {
			tab.addEventListener("click", () => demo.setTab(tab.dataset.tab));
			tab.addEventListener("keydown", (event) => {
				if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				const target =
					event.key === "Home"
						? tabs[0]
						: event.key === "End"
							? tabs[tabs.length - 1]
							: tabs[1 - tabs.indexOf(tab)];
				demo.setTab(target.dataset.tab);
				target.focus();
			});
		}
		byId("next-button").addEventListener("click", () => demo.next());
		byId("revise-button").setAttribute("aria-controls", "revision-note");
		byId("revise-button").addEventListener("click", () => demo.revise());
		for (const link of doc.querySelectorAll("[data-open-discussion]")) {
			link.addEventListener("click", () => demo.setTab("discuss"));
		}
		byId("motion-toggle").addEventListener("click", function () {
			paused = !paused;
			doc.body.classList.toggle("motion-paused", paused);
			this.setAttribute("aria-pressed", String(paused));
			this.textContent = paused ? "Resume ambient motion" : "Pause ambient motion";
			if (mark) {
				if (paused) mark.pause();
				else mark.resume();
			}
		});
		const nav = byId("nav");
		let scrollQueued = false;
		const updateNav = () => {
			nav.classList.toggle("scrolled", win.scrollY > 10);
			scrollQueued = false;
		};
		win.addEventListener(
			"scroll",
			() => {
				if (!scrollQueued) {
					scrollQueued = true;
					win.requestAnimationFrame(updateNav);
				}
			},
			{ passive: true }
		);
		updateNav();
		demo.emit();
		return { demo, mark };
	}
	return { scenes, FocusDemo, mount };
});
