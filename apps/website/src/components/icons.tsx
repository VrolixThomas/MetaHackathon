import Image from "next/image";
import type { CSSProperties } from "react";

export type IconName =
	| "arrow"
	| "code"
	| "layers"
	| "chat"
	| "spark"
	| "check"
	| "flow"
	| "clock"
	| "play"
	| "pause"
	| "linear"
	| "github"
	| "slack"
	| "chevron";
const paths: Record<Exclude<IconName, "slack" | "linear">, string> = {
	arrow: "M4 12h15m-6-6 6 6-6 6",
	code: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20",
	layers: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
	chat: "M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v9ZM8 8h8M8 12h5",
	spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
	check: "m5 12 4 4L19 6",
	flow: "M4 4h6v6H4zM14 14h6v6h-6zM7 10v7h7M10 7h7v7",
	clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2",
	play: "m8 4 12 8-12 8V4Z",
	pause: "M8 4v16M16 4v16",
	github:
		"M9 20c-4 1-4-2-6-2m12 4v-3.5c0-1 .1-1.5-.5-2 3-.4 5.5-1.5 5.5-6a4.7 4.7 0 0 0-1.3-3.3c.2-.5.6-2-.2-3.2 0 0-1.2-.4-3.5 1a12 12 0 0 0-6 0C6.2 3.6 5 4 5 4c-.8 1.2-.4 2.7-.2 3.2A4.7 4.7 0 0 0 3.5 10c0 4.5 2.5 5.6 5.5 6-.6.5-.5 1-.5 2V22",
	chevron: "m6 9 6 6 6-6",
};
export function Icon({
	name,
	size = 18,
	style,
	className = "",
}: { name: IconName; size?: number; style?: CSSProperties; className?: string }) {
	if (name === "slack" || name === "linear") {
		return (
			<Image
				src={`/integrations/${name}.svg`}
				width={size}
				height={size}
				className={`icon ${className}`}
				style={style}
				alt=""
				aria-hidden="true"
				unoptimized
			/>
		);
	}
	return (
		<svg
			className={`icon ${className}`}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			style={style}
		>
			<path d={paths[name]} />
		</svg>
	);
}
