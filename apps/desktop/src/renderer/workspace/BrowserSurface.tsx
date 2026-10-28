import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
	useEffect(() => {
		setAddress(state.page?.url ?? "");
	}, [state.page?.url]);
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
						onPresented?.(bounds);
					}
				})
				.catch(() => {
					if (!disposed && current === reportSequence) {
						setError("The browser surface is unavailable.");
						onPresentationError?.();
					}
				});
		};
		const resize = new ResizeObserver(report);
		if (host.current) resize.observe(host.current);
		window.addEventListener("resize", report);
		window.addEventListener("scroll", report, true);
		report();
		return () => {
			disposed = true;
			resize.disconnect();
			window.removeEventListener("resize", report);
			window.removeEventListener("scroll", report, true);
			void controller.present(null).catch(() => {});
		};
	}, [controller, visible, onPresented, onPresentationError]);
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
						name="browser-address"
						value={address}
						onChange={(event) => setAddress(event.currentTarget.value)}
						spellCheck={false}
					/>
				</form>
				<button
					type="button"
					aria-label="Close browser canvas"
					onClick={() => (onClose ? onClose() : void controller.close())}
				>
					×
				</button>
			</header>
			<fieldset className="browser-viewport-controls" aria-label="Browser viewport">
				{(["desktop", "phone"] as const).map((mode) => (
					<button
						type="button"
						key={mode}
						disabled={state.busy || !state.page}
						aria-pressed={
							mode === "phone"
								? state.page?.viewport.width === 390 && state.page.viewport.height === 844
								: state.page?.viewport.width === 1024 && state.page.viewport.height === 768
						}
						onClick={() => {
							if (onViewport) {
								onViewport(mode);
								return;
							}
							const box = host.current?.getBoundingClientRect();
							void controller.setViewport(mode, box ? contentBounds(box, visible) : null);
						}}
					>
						{mode === "phone" ? "Phone" : "Desktop"}
					</button>
				))}
				{state.page && (
					<span data-testid="browser-viewport">
						{state.page.viewport.width} × {state.page.viewport.height}
					</span>
				)}
			</fieldset>
			<div className="browser-page-label">
				<strong>{state.page?.title || "Website"}</strong>
				<span title="This running page has not been verified against the pull request revision.">
					{state.page?.provenance === "website-unverified-revision" ? "Website" : "Local preview"} ·
					revision unverified
				</span>
			</div>
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
