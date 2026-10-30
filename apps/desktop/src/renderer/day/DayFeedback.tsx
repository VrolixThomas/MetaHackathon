/** Shared, honest states for both the contextual queue and the selected work item. */
export function DayFeedback({
	state,
	onRetry,
}: {
	state: "loading" | "empty" | "error" | "missing";
	onRetry?(): void;
}) {
	const messages = {
		loading: ["Loading your day…", "Reading your saved work and source context."],
		empty: [
			"Your day is clear",
			"Captured commitments will appear here. You can also capture one yourself.",
		],
		error: ["Your day could not be loaded", "Retry to check the latest saved work."],
		missing: ["This work item is unavailable", "Refresh, or choose another item in the sidebar."],
	} as const;
	const [title, detail] = messages[state];
	return (
		<div className="day-feedback" role={state === "error" ? "alert" : "status"}>
			<strong>{title}</strong>
			<p>{detail}</p>
			{onRetry && (state === "error" || state === "missing") && (
				<button type="button" className="quiet" onClick={onRetry}>
					Retry
				</button>
			)}
		</div>
	);
}
