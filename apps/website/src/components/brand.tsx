"use client";
import Controller from "@/lib/identity/controller.mjs";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";

export function Brand({ name = true, size = 30 }: { name?: boolean; size?: number }) {
	return (
		<span className="brand">
			<Image src="/brand/mark-small.svg" width={size} height={size} alt="" unoptimized />
			{name && (
				<span>
					Muse<span className="brand-focus">Focus</span>
				</span>
			)}
		</span>
	);
}
export function AnimatedBrand({
	paused,
	focusToken,
	size = 120,
	autoAdvance = false,
}: { paused: boolean; focusToken: string; size?: number; autoAdvance?: boolean }) {
	const host = useRef<HTMLSpanElement>(null);
	const controller = useRef<Controller | null>(null);
	const previous = useRef(focusToken);
	const pendingFocus = useRef(false);
	const [ready, setReady] = useState(false);
	useEffect(() => {
		if (!host.current) return;
		const mark = new Controller(host.current, {
			size,
			theme: "dark",
			decorative: true,
			backgroundMotion: true,
			onStateChange: (state) => {
				// Coalesce rapid selections into one final handoff after the current one settles.
				if (!state.transitioning && pendingFocus.current) {
					pendingFocus.current = false;
					controller.current?.advance();
				}
			},
		});
		controller.current = mark;
		setReady(true);
		return () => {
			mark.destroy();
			controller.current = null;
		};
	}, [size]);
	useEffect(() => {
		if (paused) controller.current?.pause();
		else controller.current?.resume();
	}, [paused]);
	useEffect(() => {
		if (previous.current !== focusToken && controller.current) {
			pendingFocus.current = !controller.current.advance();
		}
		previous.current = focusToken;
	}, [focusToken]);
	useEffect(() => {
		if (!autoAdvance || paused) return;
		let timer: ReturnType<typeof setTimeout>;
		const advance = () => {
			const mark = controller.current;
			const bounds = host.current?.getBoundingClientRect();
			if (
				mark &&
				!document.hidden &&
				!mark.getState().reducedMotion &&
				bounds &&
				bounds.bottom > 0 &&
				bounds.top < window.innerHeight
			) {
				mark.advance();
			}
			timer = setTimeout(advance, 3200);
		};
		// The selected motion holds for 2.4s, then brings the next surface forward in 0.8s.
		timer = setTimeout(advance, 2400);
		return () => clearTimeout(timer);
	}, [autoAdvance, paused]);
	return (
		<span className="animated-brand" style={{ width: size, height: size }} aria-hidden="true">
			<Image
				className={ready ? "brand-fallback is-ready" : "brand-fallback"}
				src="/brand/pull-forward.png"
				width={size}
				height={size}
				alt=""
				priority
			/>
			<span ref={host} className="brand-motion" />
		</span>
	);
}
