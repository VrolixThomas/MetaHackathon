import { type ReactNode, useEffect, useRef, useState } from "react";
import { BrowserSurface } from "./BrowserSurface";
import { clampSplit, splitLimits } from "./layout";
import type { LocalBrowserController } from "./local-browser";

export function WorkSplit({
	children,
	browser,
	obscured,
}: { children: ReactNode; browser?: LocalBrowserController; obscured: boolean }) {
	const host = useRef<HTMLDivElement>(null);
	const pointer = useRef<number | null>(null);
	const [share, setShare] = useState(55);
	const [dragging, setDragging] = useState(false);
	const [width, setWidth] = useState(1080);
	const limits = splitLimits(width);
	useEffect(() => {
		const resize = new ResizeObserver(([entry]) => {
			if (entry && entry.contentRect.width > 0) {
				setWidth(entry.contentRect.width);
				setShare((current) => clampSplit(current, entry.contentRect.width));
			}
		});
		if (host.current) resize.observe(host.current);
		return () => resize.disconnect();
	}, []);
	const move = (clientX: number) => {
		const box = host.current?.getBoundingClientRect();
		if (box && box.width > 0) {
			setWidth(box.width);
			setShare(clampSplit(((clientX - box.left) / box.width) * 100, box.width));
		}
	};
	const stop = () => {
		pointer.current = null;
		setDragging(false);
	};
	return (
		<div
			className={`work-split ${browser ? "has-browser" : ""}`}
			ref={host}
			style={
				browser ? { gridTemplateColumns: `minmax(0, ${share}%) 6px minmax(0, 1fr)` } : undefined
			}
		>
			{children}
			{browser && (
				<>
					<hr
						className="workspace-divider"
						tabIndex={0}
						aria-label="Resize work and browser panes"
						aria-orientation="vertical"
						aria-valuemin={Math.round(limits.min)}
						aria-valuemax={Math.round(limits.max)}
						aria-valuenow={Math.round(share)}
						onPointerDown={(event) => {
							if (event.button !== 0) return;
							event.preventDefault();
							pointer.current = event.pointerId;
							event.currentTarget.setPointerCapture(event.pointerId);
							setDragging(true);
							move(event.clientX);
						}}
						onPointerMove={(event) => {
							if (pointer.current === event.pointerId) move(event.clientX);
						}}
						onPointerUp={stop}
						onPointerCancel={stop}
						onLostPointerCapture={stop}
						onKeyDown={(event) => {
							if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
							event.preventDefault();
							const size = host.current?.getBoundingClientRect().width ?? width;
							setWidth(size);
							const range = splitLimits(size);
							setShare((current) =>
								clampSplit(
									event.key === "Home"
										? range.min
										: event.key === "End"
											? range.max
											: current + (event.key === "ArrowRight" ? 5 : -5),
									size
								)
							);
						}}
					/>
					<BrowserSurface controller={browser} visible={!obscured && !dragging} />
				</>
			)}
		</div>
	);
}
