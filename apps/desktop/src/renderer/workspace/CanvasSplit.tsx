import { type ReactNode, useEffect, useRef, useState } from "react";
import { clampSplit, splitLimits } from "./layout";

/** The browser receives visible=false during a drag so its native view cannot cover the handle. */
export function CanvasSplit({
	split,
	obscured,
	renderPane,
}: {
	split: boolean;
	obscured: boolean;
	renderPane(pane: "primary" | "secondary", visible: boolean): ReactNode;
}) {
	const host = useRef<HTMLDivElement>(null);
	const pointer = useRef<number | null>(null);
	const [share, setShare] = useState(55);
	const [dragging, setDragging] = useState(false);
	const [width, setWidth] = useState(1080);
	const limits = splitLimits(width);
	useEffect(() => {
		const observer = new ResizeObserver(([entry]) => {
			if (!entry || entry.contentRect.width <= 0) return;
			setWidth(entry.contentRect.width);
			setShare((current) => clampSplit(current, entry.contentRect.width));
		});
		if (host.current) observer.observe(host.current);
		return () => observer.disconnect();
	}, []);
	const move = (clientX: number) => {
		const box = host.current?.getBoundingClientRect();
		if (box?.width) setShare(clampSplit(((clientX - box.left) / box.width) * 100, box.width));
	};
	const stop = () => {
		pointer.current = null;
		setDragging(false);
	};
	return (
		<div
			ref={host}
			className={`canvas-split${split ? " canvas-split-pair" : ""}`}
			style={split ? { gridTemplateColumns: `minmax(0, ${share}%) 6px minmax(0, 1fr)` } : undefined}
		>
			{renderPane("primary", !obscured && !dragging)}
			{split && (
				<>
					<hr
						className="workspace-divider"
						tabIndex={0}
						aria-label="Resize canvas panes"
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
					{renderPane("secondary", !obscured && !dragging)}
				</>
			)}
		</div>
	);
}
