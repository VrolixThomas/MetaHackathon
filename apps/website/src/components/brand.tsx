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
}: { paused: boolean; focusToken: string; size?: number }) {
	const host = useRef<HTMLSpanElement>(null);
	const controller = useRef<Controller | null>(null);
	const previous = useRef(focusToken);
	const [ready, setReady] = useState(false);
	useEffect(() => {
		if (!host.current) return;
		const mark = new Controller(host.current, {
			size,
			theme: "dark",
			decorative: true,
			backgroundMotion: true,
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
		if (previous.current !== focusToken) controller.current?.advance();
		previous.current = focusToken;
	}, [focusToken]);
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
