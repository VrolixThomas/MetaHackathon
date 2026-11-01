import type { ChapterId } from "./story";

export const captures: Record<ChapterId, { src: string; alt: string; caption: string }> = {
	plan: {
		src: "/captures/planning.jpg",
		alt: "MuseFocus displaying MET-77 and the saved decision about persistence across browser restarts",
		caption: "MET-77: a concrete storage-lifetime question before choosing the implementation.",
	},
	review: {
		src: "/captures/review.jpg",
		alt: "MuseFocus PR 1 review with source diff, file navigation and inferred explanation",
		caption: "PR #1: follow the focus update change through its prepared reading order.",
	},
	flow: {
		src: "/captures/flow.jpg",
		alt: "MuseFocus source-flow canvas beginning at the exact HTTP entry point",
		caption: "The source-flow canvas connects the HTTP entry, update selection and focus policy.",
	},
	fix: {
		src: "/captures/fix.jpg",
		alt: "MuseFocus suggested fix for PR 2 with a message identity diff and successful actual local test and build receipts",
		caption:
			"PR #2: inspect the proposed Slack request identity fix and its actual local check results.",
	},
	follow: {
		src: "/captures/approval.jpg",
		alt: "MuseFocus conditional approval draft for PR 3, with authorization unchecked and confirmation disabled",
		caption:
			"PR #3: review the exact approval scope before authorizing it. This capture remains a draft.",
	},
	clarify: {
		src: "/captures/slack.jpg",
		alt: "MuseFocus My day item The focus page is broken with a proposed Slack clarification awaiting inspection",
		caption:
			"A Slack-backed request in My day, with a clarification proposal awaiting inspection and authorization.",
	},
};
