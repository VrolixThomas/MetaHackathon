import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { BrowserBounds, LocalBrowserCommand } from "../../shared/contracts";
import { contentBounds } from "./layout";
import type { LocalBrowserController } from "./local-browser";

export function BrowserSurface({
	controller,
	visible,
	onPresented,
	onPresentationError,
	onCommand,
	onViewport,
	onClose,
}: {
	controller: LocalBrowserController;
	visible: boolean;
	onPresented?(bounds: BrowserBounds | null): void;
	onPresentationError?(): void;
	onCommand?(command: LocalBrowserCommand): void;
	onViewport?(mode: "desktop" | "phone"): void;
	onClose?(): void;
}) {
	const state = useStore(controller.store);
	const host = useRef<HTMLDivElement>(null);
	const [address, setAddress] = useState(state.page?.url ?? "");
	const [error, setError] = useState("");
	const detailsId = useId();
	const viewportMode =
		state.page?.viewportMode ??
		(state.page?.viewport.width === 390 && state.page.viewport.height === 844
			? "phone"
			: "desktop");
	const provenance =
		state.page?.provenance === "website-unverified-revision" ? "Website" : "Local preview";
	const pageDetails = state.page
		? `${state.page.viewport.width} × ${state.page.viewport.height}. ${provenance} · revision unverified. This running page has not been verified against the pull request revision.`
		: "No page open";
	useEffect(() => {
		setAddress(state.page?.url ?? "");
	}, [state.page?.url]);
	const callbacks = useRef({ onPresented, onPresentationError });
	callbacks.current = { onPresented, onPresentationError };
	const previousCallbacks = useRef({ onPresented, onPresentationError });
	const reportPresentation = useRef<(() => void) | null>(null);
	useLayoutEffect(() => {
		let disposed = false;
		let reportSequence = 0;
		const report = () => {
			const current = ++reportSequence;
			const box = host.current?.getBoundingClientRect();
			const bounds = box ? contentBounds(box, visible) : null;
			void controller
				.present(bounds)
				.then(() => {
					if (!disposed && current === reportSequence) {
						setError("");
						callbacks.current.onPresented?.(bounds);
					}
				})
				.catch(() => {
					if (!disposed && current === reportSequence) {
						setError("The browser surface is unavailable.");
						callbacks.current.onPresentationError?.();
					}
				});
		};
		reportPresentation.current = report;
		const resize = new ResizeObserver(report);
		if (host.current) resize.observe(host.current);
		window.addEventListener("resize", report);
		window.addEventListener("scroll", report, true);
		report();
		return () => {
			disposed = true;
			if (reportPresentation.current === report) reportPresentation.current = null;
			resize.disconnect();
			window.removeEventListener("resize", report);
			window.removeEventListener("scroll", report, true);
			void controller.present(null).catch(() => {});
		};
	}, [controller, visible]);
	useLayoutEffect(() => {
		if (
			previousCallbacks.current.onPresented !== onPresented ||
			previousCallbacks.current.onPresentationError !== onPresentationError
		) {
			previousCallbacks.current = { onPresented, onPresentationError };
			reportPresentation.current?.();
		}
	}, [onPresented, onPresentationError]);
	const command = (input: LocalBrowserCommand) => {
		if (onCommand) onCommand(input);
		else void controller.command(input);
	};
	return (
		<section className="native-browser-pane" aria-label="Live browser">
			<header className="browser-chrome">
				<div className="browser-navigation">
					<button
						type="button"
						aria-label="Back in browser"
						disabled={state.busy || !state.page?.canGoBack}
						onClick={() => command({ kind: "back" })}
					>
						←
					</button>
					<button
						type="button"
						aria-label="Forward in browser"
						disabled={state.busy || !state.page?.canGoForward}
						onClick={() => command({ kind: "forward" })}
					>
						→
					</button>
					<button
						type="button"
						aria-label="Reload browser"
						disabled={state.busy}
						onClick={() => command({ kind: "reload" })}
					>
						↻
					</button>
				</div>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						command({ kind: "navigate", url: address });
					}}
				>
					<input
						aria-label="Browser address"
						aria-describedby={detailsId}
						title={`${state.page?.title || "Website"}\n${pageDetails}`}
						name="browser-address"
						value={address}
						onChange={(event) => setAddress(event.currentTarget.value)}
						spellCheck={false}
					/>
				</form>
				<select
					className="browser-viewport-select"
					aria-label="Browser viewport"
					aria-describedby={detailsId}
					title={`${viewportMode === "fixed" ? "Fixed viewport" : viewportMode === "phone" ? "Phone" : "Desktop · fits pane"}: ${pageDetails}`}
					value={viewportMode}
					disabled={state.busy || !state.page}
					onChange={(event) => {
						const mode = event.currentTarget.value;
						if (mode !== "desktop" && mode !== "phone") return;
						if (onViewport) {
							onViewport(mode);
							return;
						}
						const box = host.current?.getBoundingClientRect();
						void controller.setViewport(mode, box ? contentBounds(box, visible) : null);
					}}
				>
					<option value="desktop">Desktop</option>
					<option value="phone">Phone</option>
					{viewportMode === "fixed" && <option value="fixed">Fixed</option>}
				</select>
				<button
					type="button"
					aria-label="Close browser canvas"
					onClick={() => (onClose ? onClose() : void controller.close())}
				>
					×
				</button>
				<span id={detailsId} className="browser-page-details" data-testid="browser-viewport">
					{pageDetails}
				</span>
			</header>
			{(state.error || error) && (
				<p className="browser-surface-error" role="alert">
					{state.error || error}
				</p>
			)}
			<div
				ref={host}
				className="native-browser-content"
				data-native-browser-content="true"
				aria-label="Native browser content"
			/>
		</section>
	);
}
