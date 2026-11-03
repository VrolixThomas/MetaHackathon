async function planning(d) {
	const { say, rpc, report, assert } = d;
	const before = (await rpc("query", "hub.snapshot")).jobs.length;
	assert.equal(before, 0);
	await say("Hello Muse. Let’s discuss my work before starting anything.", { id: "greeting" });
	await say("Bring me to my ticket boards.", { id: "ticket-navigation" });
	await say(
		"Open MET-77 and talk me through the product tradeoff before we start. What do you recommend?",
		{ id: "ticket-design" }
	);
	await say("Keep it across refreshes and browser restarts, only on this device.", {
		id: "scope-choice",
	});
	assert.equal(
		(await rpc("query", "hub.snapshot")).jobs.length,
		0,
		"A scope discussion/choice must not dispatch"
	);
	await say("What could surprise me about that choice?", { id: "scope-consequence" });
	await say("Why keep it device-local for the first version?", { id: "scope-rationale" });
	await say("What happens for someone whose browser blocks storage?", { id: "scope-failure" });
	report.assertions.push({
		name: "Planning and preference remain discussion without execution",
		passed: true,
	});
}
async function common(d) {
	const { say, rpc, report, assert } = d;
	await planning(d);
	await say("Explain a little more about how you would keep this small.", {
		id: "interrupt-target",
		firstAudioOnly: true,
	});
	await say("Stop.", { id: "stop", stop: true });
	assert.equal(
		(await rpc("query", "hub.snapshot")).jobs.length,
		0,
		"Stop must not start/cancel a worker"
	);
	await say("Continue with the decision we were discussing. No coding yet.", {
		id: "scope-continue",
	});
	report.assertions.push({
		name: "discussion and choice do not dispatch; Stop has no model/TTS action; followup stays conversational",
		passed: true,
	});
}
async function full(d) {
	const { say, rpc, wait, ui, state, report, assert, js } = d;
	await say(
		"Build the MET-77 v1 now: persist on and off across refreshes and browser restarts on this device, no sync; keep the toggle usable in memory if storage is blocked. Keep the result local for review.",
		{ id: "dispatch" }
	);
	const job = await wait(
		"real coding admission",
		async () => {
			const s = await rpc("query", "hub.snapshot");
			return s.jobs.find((j) => j.ticket?.identifier === "MET-77");
		},
		30000
	);
	await review(d);
	await collaboration(d);
	const ready = await wait(
		"actual coding child and independent checks finish",
		async () => {
			const s = await rpc("query", "hub.snapshot");
			const j = s.jobs.find((j) => j.id === job.id);
			if (["failed", "cancelled"].includes(j?.state)) throw Error(`Coding failed: ${j.state}`);
			return j?.state === "ready" ? j : false;
		},
		240000
	);
	await say(
		"Show me the completed MET-77 work and explain the important behavior, not a list of files. Do not publish it.",
		{ id: "job-review" }
	);
	assert.equal(ready.state, "ready");
	assert(!ready.reviewedAt);
	assert(
		ready.checks.length >= 2 &&
			ready.checks.every((c) => c.exitCode === 0 && c.commitSha === ready.headSha),
		"Actual coding checks must pass on its candidate head"
	);
	report.completedJob = ready;
	const beforeRestart = (await rpc("query", "hub.snapshot")).jobs.map((j) => ({
		id: j.id,
		headSha: j.headSha,
	}));
	await d.restartListening();
	await say("Open MET-77 and talk me through the product decision before we do anything.", {
		id: "existing-work-planning",
	});
	await say("Across browser restarts, on this device only. We are only discussing it.", {
		id: "existing-work-choice",
	});
	await say("Did you just start that work?", { id: "existing-work-chronology" });
	assert.deepEqual(
		(await rpc("query", "hub.snapshot")).jobs.map((j) => ({ id: j.id, headSha: j.headSha })),
		beforeRestart,
		"Fresh foreground conversation must not recreate or revise existing ready work"
	);
	report.assertions.push({
		name: "Historical ready work survives fresh voice session without new admission",
		passed: true,
	});

	report.assertions.push({
		name: "live coding/model/tool flow and review/flow/fix/conditional-followup/Slack clarification executed",
		passed: true,
	});
}
async function collaboration(d) {
	const { say, rpc, wait, state, report, assert } = d;
	if (!d.skipFix) {
		await say(
			"Prepare a suggested fix for the reviewer feedback on my Slack-capture PR. Keep it local and run its real checks.",
			{ id: "proposed-fix" }
		);
	}
	await say(
		"Open the source-link PR, number 3. Set a follow-up to notify me only once demo-checks succeeds, expiring in one hour. Do not approve or merge.",
		{ id: "approval-proposal" }
	);
	const notification = (await rpc("query", "prApprovals.list")).find(
		(p) => p.pr.id === d.fixture.pulls[2].id && p.status === "draft"
	);
	assert(notification, "An actual notification policy must exist before confirmation");
	assert.equal(notification.terms.action, "notify");
	assert(
		notification.terms.conditions.length === 1 &&
			notification.terms.conditions[0].kind === "check" &&
			notification.terms.conditions[0].name === "demo-checks"
	);
	assert(
		Math.abs(
			Date.parse(notification.terms.expiresAt) - report.turns.at(-1).submittedAt - 3600000
		) <= 90000,
		"The actual deadline must match the requested one-hour bound"
	);
	report.notificationProposal = notification;
	await say("Confirm this delegation.", { id: "approval-confirm" });
	state.checkStatus = "success";
	await wait(
		"confirmed followup outcome",
		async () => {
			const ps = await rpc("query", "prApprovals.list");
			return ps.some((p) => p.status === "notified");
		},
		70000
	);
	assert(
		!report.simulatedWrites.some((w) => w.provider === "github"),
		"Notify-only policy cannot approve"
	);
	state.checkStatus = "pending";
	await say(
		"For this reviewed head of PR 3, approve automatically only when demo-checks succeeds, expiring in one hour. Do not merge.",
		{ id: "automatic-approval-proposal" }
	);
	const approval = (await rpc("query", "prApprovals.list")).find(
		(p) => p.pr.id === d.fixture.pulls[2].id && p.status === "draft"
	);
	assert(
		approval && approval.terms.action === "approve",
		"The exact approval proposal must exist before confirmation"
	);
	assert(
		approval.terms.conditions.length === 1 &&
			approval.terms.conditions[0].kind === "check" &&
			approval.terms.conditions[0].name === "demo-checks"
	);
	assert(
		Math.abs(Date.parse(approval.terms.expiresAt) - report.turns.at(-1).submittedAt - 3600000) <=
			90000
	);
	report.approvalProposal = approval;
	state.allowApproval = true;
	await say("Confirm this delegation.", { id: "automatic-approval-confirm" });
	assert(
		!report.simulatedWrites.some((w) => w.provider === "github"),
		"Pending check must withhold approval"
	);
	state.checkStatus = "success";
	await wait(
		"actual conditional approval receipt",
		async () => {
			const policies = await rpc("query", "prApprovals.list");
			return policies.find((p) => p.status === "approved" && p.attempt?.receipt);
		},
		70000
	);
	await slack(d);
	if (!d.skipFix) {
		const candidate = await wait(
			"actual suggested fix becomes ready",
			async () => {
				const candidates = await rpc("query", "prFixes.list");
				const fix = candidates.find((f) => f.pr.id === d.fixture.pulls[1].id);
				if (["failed", "interrupted", "needs-input"].includes(fix?.phase))
					throw Error(`Fix not ready: ${fix.phase}: ${fix.error ?? fix.question}`);
				return fix?.phase === "ready" ? fix : false;
			},
			240000
		);
		assert(
			candidate.checks.length > 0 &&
				candidate.checks.every((c) => c.exitCode === 0 && c.commitSha === candidate.headSha)
		);
		await say(
			"Open the prepared Slack-capture suggested fix and explain the behavioral correction. Keep it unpublished.",
			{ id: "fix-review" }
		);
		report.completedFix = await rpc("query", "prFixes.detail", { id: candidate.id });
	}

	assert.equal(
		report.simulatedWrites.filter((w) => w.provider === "github").length,
		1,
		"Exactly one controlled approval receipt, no publication or merge"
	);
	report.assertions.push({
		name: d.skipFix
			? "conditional approval and Slack clarification"
			: "suggested fix, conditional approval and Slack clarification",
		passed: true,
	});
}
async function slack(d) {
	const { say, rpc, wait, state, report } = d;
	state.slackEnabled = true;
	const item = await wait(
		"actual intake captures original Slack request",
		async () => {
			const s = await rpc("query", "day.snapshot");
			return s.items.find((i) => i.title.includes("focus") || i.summary.includes("focus"));
		},
		90000
	);
	await say(
		"Open the Slack request about the focus page. Ask the requester which page and what happened before it failed. Clarification only; do not start work.",
		{ id: "slack-proposal" }
	);
	const proposed = (await rpc("query", "day.snapshot")).items.find((i) => i.id === item.id);
	assert(
		proposed?.clarificationMetadata?.status === "proposed" ||
			proposed?.clarification?.status === "proposed",
		"An actual clarification proposal must exist before confirmation"
	);
	report.clarificationProposal = proposed;
	state.allowSlackQuestion = true;
	await say("Confirm this clarification delegation.", { id: "slack-confirm" });
	await wait(
		"actual delegated question reaches controlled source ledger",
		() => report.simulatedWrites.some((w) => w.provider === "slack"),
		90000
	);
	state.answerTs = `${Math.floor(Date.now() / 1000)}.000500`;
	state.answerText =
		"I turned focus on in the local companion in Chrome, refreshed the page, and focus was off again.";
	await say("What did we learn from that request, and does it change what we planned?", {
		id: "slack-context",
	});

	report.assertions.push({
		name: "Slack clarification uses actual source-bound delegation and controlled delivery receipt",
		passed: true,
	});
}
async function review(d) {
	const { say, rpc, report, assert } = d;
	await say("Open the quiet-updates PR and explain where you would start reviewing it and why.", {
		id: "pr-review",
	});
	await say("What could still interrupt me while focus is on? Ground it in the code.", {
		id: "pr-risk",
	});
	await say("Show me the entire flow from the browser request to delivering an update.", {
		id: "source-flow",
	});
	const flowObservation = await rpc("query", "workspace.observe", {
		sessionId: report.turns.at(-1).identity.sessionId,
	});
	const flow = flowObservation.workspace.canvases.find(
		(c) => c.id === flowObservation.workspace.primaryId && c.kind === "flow"
	);
	assert(flow, "Flow must be the acknowledged primary canvas");
	const paths = flow.flow.steps.map((step) => step.source.location.path);
	assert(
		paths.includes("src/http/app.mjs") && paths.includes("src/attention/build-update.mjs"),
		"Entire flow must include the unchanged request entry and delivery orchestration"
	);
	assert(
		flow.flow.steps.every((step) => step.source.location.commitSha === d.fixture.pulls[0].headSha),
		"Flow source must stay pinned to the actual PR revision"
	);
	report.sourceFlow = flow;
	await say(`Open ${d.previewUrl} in the browser so we can try the companion.`, {
		id: "local-browser",
	});
	const desktopBrowser = await rpc("query", "workspace.observe", {
		sessionId: report.turns.at(-1).identity.sessionId,
	});
	await say("Show that same page at phone size.", { id: "phone-browser" });
	const browserObservation = await rpc("query", "workspace.observe", {
		sessionId: report.turns.at(-1).identity.sessionId,
	});
	report.browserObservation = browserObservation;
	assert(
		browserObservation.browser?.viewport.width === 390 &&
			browserObservation.browser.viewport.height === 844 &&
			browserObservation.browser.presented &&
			browserObservation.browser.browserId === desktopBrowser.browser?.browserId &&
			browserObservation.browser.documentId === desktopBrowser.browser?.documentId,
		"Actual same-page phone viewport must settle"
	);

	report.assertions.push({
		name: "actual PR, pinned source-flow and persistent browser/phone",
		passed: true,
	});
}
async function variants(d) {
	const { say, rpc, assert, report } = d;
	await say("Take me to my tickets.", { id: "ticket-navigation" });
	await say("Open MET-80. Before we change anything, what should I be thinking about?", {
		id: "ticket-design",
	});
	await say("What would you recommend so I can get back to my review easily?", {
		id: "variant-recommendation",
	});
	await say("I prefer opening the original source separately. No coding yet.", {
		id: "variant-choice",
	});
	await say("What is the main downside of that choice?", { id: "variant-downside" });
	await say("Why would that be a good first version?", { id: "variant-rationale" });
	await say("Is there anything important I still need to decide before we start?", {
		id: "variant-decisions",
	});
	assert.equal(
		(await rpc("query", "hub.snapshot")).jobs.length,
		0,
		"Discussion variants must not admit work"
	);
	await say("Could you actually check whether the source link opens in a new tab?", {
		id: "variant-source-question",
	});
	assert.equal(
		(await rpc("query", "hub.snapshot")).jobs.length,
		0,
		"An implementation question does not authorize coding"
	);
	report.assertions.push({
		name: "Another ticket and varied planning phrases retain discussion without execution",
		passed: true,
	});
}
module.exports = { common, full, collaboration, slack, review, variants, planning };
