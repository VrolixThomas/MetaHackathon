import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { contentBounds } from "./layout";
import type { LocalBrowserController } from "./local-browser";

export function BrowserSurface({
	controller,
	visible,
}: { controller: LocalBrowserController; visible: boolean }) {
	const state = useStore(controller.store);
	const host = useRef<HTMLDivElement>(null);
	const [address, setAddress] = useState(state.page?.url ?? "");
	const [error, setError] = useState("");
	useEffect(() => {
		setAddress(state.page?.url ?? "");
	}, [state.page?.url]);
	useEffect(() => {
		let disposed = false;
		const report = () => {
			const box = host.current?.getBoundingClientRect();
			void controller
				.present(box ? contentBounds(box, visible) : null)
				.then(() => {
					if (!disposed) setError("");
				})
				.catch(() => {
					if (!disposed) setError("The browser surface is unavailable.");
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
	}, [controller, visible]);
	return (
		<section className="native-browser-pane" aria-label="Local browser">
			<header className="browser-chrome">
				<div className="browser-navigation">
					<button
						type="button"
						aria-label="Back in browser"
						disabled={state.busy || !state.page?.canGoBack}
						onClick={() => void controller.command({ kind: "back" })}
					>
						←
					</button>
					<button
						type="button"
						aria-label="Forward in browser"
						disabled={state.busy || !state.page?.canGoForward}
						onClick={() => void controller.command({ kind: "forward" })}
					>
						→
					</button>
					<button
						type="button"
						aria-label="Reload browser"
						disabled={state.busy}
						onClick={() => void controller.command({ kind: "reload" })}
					>
						↻
					</button>
				</div>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void controller.command({ kind: "navigate", url: address });
					}}
				>
					<input
						aria-label="Local browser address"
						name="browser-address"
						value={address}
						onChange={(event) => setAddress(event.currentTarget.value)}
						spellCheck={false}
					/>
				</form>
				<button
					type="button"
					aria-label="Close local browser"
					onClick={() => void controller.close()}
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
				<strong>{state.page?.title || "Local preview"}</strong>
				<span title="This running page has not been verified against the pull request revision.">
					Local preview · revision unverified
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
