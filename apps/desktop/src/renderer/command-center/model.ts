import type { CenterSection, HubSnapshot, WorkJobSummary } from "../../shared/contracts";

export const centerSections: { id: CenterSection; label: string }[] = [
	{ id: "home", label: "Home" },
	{ id: "reviews", label: "Incoming reviews" },
	{ id: "feedback", label: "Own PR feedback" },
	{ id: "tickets", label: "My tickets" },
	{ id: "completed", label: "Completed work" },
	{ id: "activity", label: "Activity queue" },
];
export const jobTitle = (job: Pick<WorkJobSummary, "ticket" | "feedback" | "summary" | "branch">) =>
	job.ticket?.title ??
	(job.feedback
		? `Review suggestion · ${job.feedback.path ?? job.feedback.prId}`
		: job.summary || job.branch);
export const jobReference = (
	job: Pick<WorkJobSummary, "ticket" | "feedback" | "summary" | "branch">
) => job.ticket?.identifier ?? job.feedback?.prId ?? job.branch;
export const isFinished = (state: string) => ["ready", "failed", "cancelled"].includes(state);
export const stateLabel = (state: string) => state.replaceAll("-", " ");
export const priorityLabel = (priority: number) =>
	["No priority", "Urgent", "High", "Normal", "Low"][priority] ?? "No priority";
export function sectionCount(snapshot: HubSnapshot, section: CenterSection) {
	switch (section) {
		case "home":
			return snapshot.jobs.reduce((count, job) => count + job.pendingDecisions, 0);
		case "reviews":
			return snapshot.reviews.filter((item) => item.kind === "incoming").length;
		case "feedback":
			return snapshot.reviews.filter((item) => item.kind === "own").length;
		case "tickets":
			return snapshot.tickets.filter(
				(ticket) => !["completed", "canceled"].includes(ticket.state.type)
			).length;
		case "completed":
			return snapshot.jobs.filter((job) => isFinished(job.state)).length;
		case "activity":
			return snapshot.jobs.filter((job) => !isFinished(job.state)).length;
	}
}
export type PriorityItem = {
	id: string;
	title: string;
	detail: string;
	label: string;
	section: CenterSection;
	selectedId: string;
	tone: string;
};
/** A deterministic brief of observed work; never generates missing summaries or outcomes. */
export function priorityItems(snapshot: HubSnapshot): PriorityItem[] {
	const decisions = snapshot.jobs
		.filter((job) => job.pendingDecisions > 0)
		.map(
			(job): PriorityItem => ({
				id: `decision:${job.id}`,
				title: jobTitle(job),
				detail: `${jobReference(job)} · ${job.pendingDecisions} pending decision${job.pendingDecisions === 1 ? "" : "s"}`,
				label: "Needs your input",
				section: "activity",
				selectedId: job.id,
				tone: "attention",
			})
		);
	const ready = snapshot.jobs
		.filter((job) => job.state === "ready")
		.map(
			(job): PriorityItem => ({
				id: `ready:${job.id}`,
				title: jobTitle(job),
				detail: `${job.repository} · ${job.changedFileCount} changed file${job.changedFileCount === 1 ? "" : "s"}`,
				label: "Ready to inspect",
				section: "completed",
				selectedId: job.id,
				tone: "ready",
			})
		);
	const failed = snapshot.jobs
		.filter((job) => job.state === "failed")
		.map(
			(job): PriorityItem => ({
				id: `failed:${job.id}`,
				title: jobTitle(job),
				detail: `${jobReference(job)} · Open the saved job for details`,
				label: "Work needs attention",
				section: "completed",
				selectedId: job.id,
				tone: "attention",
			})
		);
	const feedback = snapshot.reviews
		.filter((item) => item.kind === "own" && item.feedbackCount > 0)
		.map(
			(item): PriorityItem => ({
				id: `feedback:${item.pr.id}`,
				title: item.pr.title,
				detail: `${item.pr.repository} #${item.pr.number} · ${item.feedbackCount} feedback item${item.feedbackCount === 1 ? "" : "s"}`,
				label: "Feedback on your PR",
				section: "feedback",
				selectedId: item.pr.id,
				tone: "neutral",
			})
		);
	const reviews = snapshot.reviews
		.filter((item) => item.kind === "incoming")
		.map(
			(item): PriorityItem => ({
				id: `review:${item.pr.id}`,
				title: item.pr.title,
				detail: `${item.pr.repository} #${item.pr.number} · ${item.pr.author}`,
				label: "Your review requested",
				section: "reviews",
				selectedId: item.pr.id,
				tone: "neutral",
			})
		);
	const tickets = snapshot.tickets
		.filter((ticket) => !["completed", "canceled"].includes(ticket.state.type))
		.sort((a, b) => (a.priority || 5) - (b.priority || 5))
		.map(
			(ticket): PriorityItem => ({
				id: `ticket:${ticket.id}`,
				title: ticket.title,
				detail: `${ticket.identifier} · ${priorityLabel(ticket.priority)} · ${ticket.state.name}`,
				label: "Assigned to you",
				section: "tickets",
				selectedId: ticket.id,
				tone: "neutral",
			})
		);
	return [...decisions, ...ready, ...failed, ...feedback, ...reviews, ...tickets].slice(0, 8);
}
