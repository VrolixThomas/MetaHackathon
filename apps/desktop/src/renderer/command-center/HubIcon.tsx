import type { CenterSection } from "../../shared/contracts";

const paths: Record<CenterSection | "settings" | "plus" | "repository" | "conversation", string> = {
	home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
	reviews: "M6 3v12a3 3 0 1 0 3 3H6m0-12a3 3 0 1 0 0 .1M18 3v4a5 5 0 0 1-5 5H6m12-9a3 3 0 1 0 0 .1",
	feedback: "M21 11a8 8 0 0 1-8 8H7l-4 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3ZM7 8h10M7 12h6",
	tickets: "m3 6 2 2 4-4m3 2h9M3 12l2 2 4-4m3 2h9M3 18l2 2 4-4m3 2h9",
	completed: "m7 12 3 3 7-7M21 12a9 9 0 1 1-5-8",
	activity: "M3 12h4l3-8 4 16 3-8h4",
	settings:
		"m9 3-1 3-3 1-2 3 2 2v3l3 2 1 3h6l1-3 3-2v-3l2-2-2-3-3-1-1-3ZM12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8",
	plus: "M12 4v16M4 12h16",
	repository: "M4 4h16v16H4ZM8 4v16M11 8h6M11 12h6",
	conversation: "M4 4h16v13H9l-5 4ZM8 8h8M8 12h5",
};
export function HubIcon({ name }: { name: keyof typeof paths }) {
	return (
		<svg
			viewBox="0 0 24 24"
			width="20"
			height="20"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={paths[name]} />
		</svg>
	);
}
