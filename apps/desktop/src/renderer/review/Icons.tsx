export function Icon({
	name,
	size = 18,
}: {
	name:
		| "chevron"
		| "close"
		| "mic"
		| "settings"
		| "agent"
		| "check"
		| "arrow"
		| "code"
		| "external";
	size?: number;
}) {
	const paths = {
		chevron: "m9 5 7 7-7 7",
		close: "m6 6 12 12M6 18 18 6",
		mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6",
		settings:
			"M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM10 2h4l1 3 3 1 3 1v4l-2 2v3l-2 3h-4l-2 2H7l-1-3-3-1V9l2-2 2-3h3Z",
		agent: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
		check: "m5 12 4 4L19 6",
		arrow: "M5 12h14m-6-6 6 6-6 6",
		code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18",
		external: "M14 3h7v7m0-7L10 14M10 3H3v18h18v-7",
	};
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={paths[name]} />
		</svg>
	);
}
