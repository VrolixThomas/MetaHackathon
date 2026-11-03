import type { WorkspaceObservation } from "../../shared/contracts";
import type { MetaItem } from "./meta-client";

// Strip only conventional politeness, never clauses, conditions or negation.
export function navigationRequest(text: string) {
	return text
		.trim()
		.replace(/\s+/g, " ")
		.replace(/[.!?]+$/, "")
		.replace(/^(?:okay[, ]+|hello[, ]+|yes[, ]+)?(?:(?:please|can you|could you) )?/i, "")
		.replace(/(?: for me)?(?: please)?$/i, "")
		.trim();
}

export function ticketNavigationTarget(text: string, observed?: WorkspaceObservation) {
	const request = navigationRequest(text);
	const match =
		/^(?:let['’]?s )?(?:open|show(?: me)?|zoom into|focus on) (?:ticket\s*)?([a-z]+-?\d+|\d+)(.*)$/i.exec(
			request
		);
	if (!match?.[1] || !observed?.capabilities.includes("center")) return undefined;
	const label = match[1].replace(/-/g, "").toUpperCase();
	const primary = observed.workspace.canvases.find((c) => c.id === observed.workspace.primaryId);
	if (
		/^\d+$/.test(label) &&
		!/\bticket\s*\d/i.test(request) &&
		!(primary?.kind === "center" && primary.section === "tickets")
	)
		return undefined;
	const targets = (observed.hub?.tickets ?? []).filter((t) =>
		/^\d+$/.test(label)
			? t.identifier.split("-").at(-1) === label
			: t.identifier.replace(/-/g, "").toUpperCase() === label
	);
	if (targets.length !== 1 || !targets[0]) return undefined;
	return { selectedId: targets[0].id, rest: match[2]?.trim() ?? "" };
}

/** Actual user ingress only. Exact UI requests; no source text, model output or write authority. */
export function explicitWorkspaceNavigation(
	text: string,
	observed?: WorkspaceObservation,
	history: MetaItem[] = []
) {
	const request = navigationRequest(text);
	const question = observedQuestionNavigation(text, observed);
	if (question) return question;
	const ticket = ticketNavigationTarget(text, observed);
	if (ticket && !ticket.rest)
		return {
			kind: "ticket" as const,
			tool: "open_command_center",
			args: { section: "tickets", selectedId: ticket.selectedId },
			selectedId: ticket.selectedId,
			acknowledgement: "That ticket is open.",
		};
	// Spoken small numbers are labels only, never positions in an unseen list.
	const numbers: Record<string, string> = {
		one: "1",
		two: "2",
		three: "3",
		four: "4",
		five: "5",
		six: "6",
		seven: "7",
		eight: "8",
		nine: "9",
		ten: "10",
	};
	const numbered = (value: string) =>
		value.replace(
			/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi,
			(word) => numbers[word.toLowerCase()] ?? word
		);
	let reviewRequest = numbered(request);
	// A distinct affirmative may accept the immediately preceding explicit offer.
	// Never read tool/source text or infer a list position as a PR number.
	const yes = numbered(text.trim().replace(/[.!?]+$/, ""));
	const namedAcceptance = /^yes[, ]+let['’]?s start number (\d+)[, ]+open it$/i.exec(yes);
	if (/^yes(?:[, ]+(?:please|open it|let['’]?s open it))?$/i.test(yes) || namedAcceptance) {
		const current = history.reduce(
			(last, item, index) => (item["role"] === "user" ? index : last),
			-1
		);
		const prior = history.slice(0, current).at(-1);
		const offer =
			prior?.["role"] === "assistant" && typeof prior["content"] === "string"
				? prior["content"]
				: "";
		// Keep this to a single explicit offer, excluding interrupted/unconfirmed history.
		const match =
			/^(?:(?:Shall I|Should I|Would you like me to|Want me to) open|(?:Shall we|Should we|Would you like to) start with) (?:PR|pull request) (?:number )?#?(\d+)\?$/i.exec(
				offer
			);
		if (match && (!namedAcceptance || namedAcceptance[1] === match[1]))
			reviewRequest = `open PR ${match[1]}`;
	}
	const pr = /^(?:let['’]?s )?(?:open|show(?: me)?) (?:PR|pull request) (?:number )?#?(\d+)$/i.exec(
		reviewRequest
	);
	if (pr && observed?.capabilities.includes("review")) {
		const reviews = new Map(
			(observed.hub?.reviews ?? []).map((r) => [r.pr.id, { pr: r.pr, status: r.preparationStatus }])
		);
		for (const review of observed.reviews) reviews.set(review.pr.id, review);
		const targets = [...reviews.values()].filter((r) => r.pr.number === Number(pr[1]));
		if (targets.length === 1 && targets[0]?.status === "ready")
			return {
				kind: "review" as const,
				tool: "open_ready_review",
				args: { prId: targets[0].pr.id },
				prId: targets[0].pr.id,
				acknowledgement: `PR #${targets[0].pr.number} is open.`,
			};
	}
	if (
		observed?.capabilities.includes("center") &&
		/^(?:(?:please|can you|could you) )?(?:(?:bring|take) me(?: over)? to|(?:open|show)(?: me)?|(?:let['’]?s )?go to|let['’]?s start (?:on|with)) (?:(?:my|the) )?(?:tickets(?: boards?)?|ticket boards?)[.!?]?$/i.test(
			request
		)
	)
		return {
			kind: "tickets" as const,
			tool: "open_command_center",
			args: { section: "tickets" },
			acknowledgement: "You're at your ticket boards.",
		};
	const url =
		/^(?:(?:please|can you|could you) )?open (https?:\/\/\S+)(?: in (?:the )?browser(?: so (?:we|I) can (?:try|test|view|see) (?:it|this|that|the (?:app|site|page|companion)))?)?[.!?]?$/i.exec(
			text.trim()
		);
	if (url?.[1] && observed?.capabilities.includes("browser") && !/[.!?]$/.test(url[1]))
		return {
			kind: "browser" as const,
			tool: "open_browser",
			args: { url: url[1] },
			acknowledgement: "It's open in the browser.",
		};
	const work =
		/^(?:please )?(?:show|open)(?: me)? (?:the )?(?:completed|ready|saved) ([a-z]+-?\d+) work\b(.*)$/i.exec(
			request
		);
	if (work?.[1] && observed?.capabilities.includes("center")) {
		const tail = work[2]?.trim() ?? "";
		const ids = new Set(
			(request.match(/\b[a-z]+-?\d+\b/gi) ?? []).map((id) => id.replace(/-/g, "").toUpperCase())
		);
		if (
			ids.size === 1 &&
			!/\b(?:if|unless|instead|later)\b/i.test(tail) &&
			(!tail ||
				/^[.!]$/.test(tail) ||
				/^and (?:explain|talk me through|walk me through)\b/i.test(tail))
		) {
			const identifier = work[1].replace(/-/g, "").toUpperCase();
			const jobs = (observed.hub?.jobs ?? []).filter(
				(job) =>
					job.state === "ready" &&
					job.headSha &&
					job.ticket?.identifier.replace(/-/g, "").toUpperCase() === identifier
			);
			if (jobs.length === 1 && jobs[0])
				return {
					kind: "completed-work" as const,
					tool: "open_command_center",
					args: { section: "completed", selectedId: jobs[0].id },
					jobId: jobs[0].id,
				};
		}
	}
	const primary = observed?.workspace.canvases.find((c) => c.id === observed.workspace.primaryId);
	if (primary?.kind !== "browser" || !observed?.browser?.presented) return undefined;
	const viewport =
		/^(?:please )?(?:show|view|switch)(?: (?:me|it|this|that|the|same|page|browser)){0,6} (?:(?:at|in|to) )?(phone|mobile|desktop) (?:size|view|mode)[.!?]?$/i.exec(
			request
		);
	if (!viewport) return undefined;
	const phone = viewport[1]?.toLowerCase() !== "desktop";
	return {
		kind: phone ? ("phone" as const) : ("desktop" as const),
		tool: "browser_action",
		args: {
			action: {
				kind: "viewport",
				viewport: phone ? { width: 390, height: 844 } : { width: 1024, height: 768 },
			},
		},
		acknowledgement: `It's at ${phone ? "phone" : "desktop"} size now.`,
	};
}

/** Only real ingress and uniquely observed labels/titles grant implicit display. */
function observedQuestionNavigation(text: string, observed?: WorkspaceObservation) {
	if (
		!observed ||
		/\b(?:don['’]t|do not|without|stay|keep|instead|unless|if|later|no navigation|just discuss here)\b/i.test(
			text
		)
	)
		return;
	const request = navigationRequest(text).replace(
		/\b(PR|pull request) (?:number )?(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi,
		(_, kind: string, number: string) =>
			`${kind} ${["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].indexOf(number.toLowerCase()) + 1}`
	);
	const questionLead = request
		.replace(/^before we (?:start|begin|work on)\s+(?:ticket\s+)?[a-z]+-?\d+,?\s*/i, "")
		.replace(/^(?:can|could) you\s+/i, "");
	if (!/^(?:what|why|how|explain|tell me about|discuss|talk me through)\b/i.test(questionLead))
		return;
	// Compound execution requests belong to the ordinary gated tool workflow.
	if (
		/\b(?:and|then|also)\s+(?:start|implement|publish|post|send|merge|approve|delete|open|show)\b/i.test(
			request
		)
	)
		return;
	// Questions comparing multiple items must not choose an arbitrary destination.
	const labels =
		request.match(
			/\b(?:ticket\s*(?:[a-z]+-?)?\d+|[a-z]+-?\d+|(?:PR|pull request)\s*(?:number\s+)?#?\d+)\b/gi
		) ?? [];
	if (labels.length > 1) return;
	const normalized = request.toLowerCase();
	const tickets = (observed.hub?.tickets ?? []).filter((ticket) => {
		const label = labels[0]
			?.replace(/^ticket\s*/i, "")
			.replace(/-/g, "")
			.toUpperCase();
		return label
			? /^\d+$/.test(label)
				? ticket.identifier.split("-").at(-1) === label
				: ticket.identifier.replace(/-/g, "").toUpperCase() === label
			: ticket.title.length >= 4 && normalized.includes(ticket.title.toLowerCase());
	});
	const reviews = new Map(
		(observed.hub?.reviews ?? []).map((r) => [r.pr.id, { pr: r.pr, status: r.preparationStatus }])
	);
	for (const review of observed.reviews) reviews.set(review.pr.id, review);
	const prNumber = /^(?:PR|pull request)\s*(?:number\s+)?#?(\d+)$/i.exec(labels[0] ?? "");
	const prs = [...reviews.values()].filter((r) =>
		labels.length
			? prNumber && r.pr.number === Number(prNumber[1])
			: r.pr.title.length >= 4 && normalized.includes(r.pr.title.toLowerCase())
	);
	if (tickets.length + prs.length !== 1) return;
	const ticket = tickets[0];
	if (ticket && observed.capabilities.includes("center"))
		return {
			kind: "ticket" as const,
			tool: "open_command_center",
			args: { section: "tickets", selectedId: ticket.id },
			selectedId: ticket.id,
			discussion: true as const,
			acknowledgement: "That ticket is open.",
		};
	const review = prs[0];
	if (review?.status === "ready" && observed.capabilities.includes("review"))
		return {
			kind: "review" as const,
			tool: "open_ready_review",
			args: { prId: review.pr.id },
			prId: review.pr.id,
			discussion: true as const,
			acknowledgement: `PR #${review.pr.number} is open.`,
		};
}
