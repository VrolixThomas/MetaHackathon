import { useEffect, useMemo, useRef, useState } from "react";
import {
	createBrowserPresenter,
	openReviewBrowser,
	refreshReviewBrowser,
	setBrowserViewport,
	useBrowserOperation,
} from "./browser-session";
import { useReview } from "./controller";
import { reviewSessionId } from "./conversation";
import { useServices } from "./services";

/** This element reserves space for the one native WebContentsView owned by main. */
export function BrowserWorkspace({ visible }: { visible: boolean }) {
	const browser = useReview((s) => s.browser);
	const browserId = browser?.browserId;
	const sourceMode = useReview((s) => s.sourceMode);
	const adapter = useServices((s) => s.browser);
	const operation = useBrowserOperation();
	const host = useRef<HTMLDivElement>(null);
	const [surfaceError, setSurfaceError] = useState("");
	const present = useMemo(
		() => (adapter ? createBrowserPresenter(adapter, reviewSessionId) : null),
		[adapter]
	);
	useEffect(() => {
		if (!present) return;
		let disposed = false;
		const report = () => {
			const box = host.current?.getBoundingClientRect();
			const bounds =
				visible && !document.hidden && browserId && box && box.width > 0 && box.height > 0
					? {
							x: Math.round(box.x),
							y: Math.round(box.y),
							width: Math.floor(box.width),
							height: Math.floor(box.height),
						}
					: null;
			void present(bounds)
				.then(() => {
					if (!disposed) setSurfaceError("");
				})
				.catch(() => {
					if (!disposed)
						setSurfaceError("The browser surface is unavailable. Try reopening checkout.");
				});
		};
		const resize = new ResizeObserver(report);
		if (host.current) resize.observe(host.current);
		window.addEventListener("resize", report);
		window.addEventListener("scroll", report, true);
		document.addEventListener("visibilitychange", report);
		report();
		return () => {
			disposed = true;
			resize.disconnect();
			window.removeEventListener("resize", report);
			window.removeEventListener("scroll", report, true);
			document.removeEventListener("visibilitychange", report);
			void present(null).catch(() => {});
		};
	}, [present, visible, browserId]);
	useEffect(() => {
		if (!visible || !adapter || sourceMode !== "repository") return;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				await refreshReviewBrowser();
			} catch {
				/* Opening reports actionable errors separately. */
			}
			if (!disposed) timer = setTimeout(() => void poll(), 750);
		};
		void poll();
		return () => {
			disposed = true;
			clearTimeout(timer);
		};
	}, [visible, adapter, sourceMode]);
	return (
		<section className="browser-workspace" hidden={!visible} aria-label="Review browser">
			<div className="browser-toolbar">
				<div className="browser-address" title={browser?.url}>
					{browser?.title || "Checkout"}
					<span>
						{browser
							? new URL(browser.url).host + new URL(browser.url).pathname
							: "Open the application from this PR"}
					</span>
				</div>
				<div className="browser-switch" aria-label="Browser revision">
					{(["head", "base"] as const).map((revision) => (
						<button
							type="button"
							key={revision}
							aria-pressed={browser?.revision === revision}
							disabled={operation.busy || sourceMode !== "repository" || !adapter}
							onClick={() => void openReviewBrowser(revision)}
						>
							{revision === "head" ? "This PR" : "Before PR"}
						</button>
					))}
				</div>
				<div className="browser-switch" aria-label="Browser viewport">
					{(["desktop", "phone"] as const).map((mode) => (
						<button
							type="button"
							key={mode}
							disabled={!browser || operation.busy}
							aria-pressed={
								browser
									? mode === "phone"
										? browser.viewport.width < 600
										: browser.viewport.width >= 600
									: mode === "desktop"
							}
							onClick={() => void setBrowserViewport(mode)}
						>
							{mode === "desktop" ? "Desktop" : "Phone"}
						</button>
					))}
				</div>
			</div>
			{(operation.error || surfaceError) && (
				<p className="browser-error" role="alert">
					{operation.error || surfaceError}
				</p>
			)}
			<div
				className={`browser-stage ${browser && browser.viewport.width < 600 ? "phone" : "desktop"}`}
			>
				<div
					className="browser-native-host"
					ref={host}
					data-browser-content="true"
					aria-label={browser ? `${browser.title}, interactive browser` : "Browser content"}
				>
					{!browser && (
						<div className="browser-empty">
							<span className="exchange-label">Explore the change</span>
							<h1>Your review, in the browser.</h1>
							<p>
								Walk through the PR, try the checkout, and follow what you find back to its code.
							</p>
							<button
								type="button"
								className="button primary"
								disabled={operation.busy || sourceMode !== "repository" || !adapter}
								onClick={() => void openReviewBrowser()}
							>
								{operation.busy ? "Opening checkout…" : "Open checkout"}
							</button>
							<p className="artifact-note">
								{sourceMode === "reference"
									? "Load the local demo to open its running checkout."
									: "Desktop opens first. Switch to Phone when you want to inspect the mobile layout."}
							</p>
						</div>
					)}
				</div>
			</div>
			<footer className="browser-footer">
				{browser ? (
					<>
						<span className="dot blue" />
						Live page · {browser.viewport.width} × {browser.viewport.height}
						<span>
							{browser.revision === "base" ? "Before PR" : "This PR"} ·{" "}
							{browser.commitSha.slice(0, 8)}
						</span>
					</>
				) : (
					"The conversation and browser share one review session."
				)}
			</footer>
		</section>
	);
}
