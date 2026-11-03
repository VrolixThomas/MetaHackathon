const { ACTOR, CHANNEL, POLICY, QUESTION, digest, canonical } = require("./provider.cjs");
async function run({
	assert,
	js,
	wait,
	sleep,
	report,
	save,
	writeConfig,
	TOKEN,
	envPath,
	day,
	standing,
	provider,
}) {
	const rpc = async (type, path, input = {}) => {
		const r = await js(
			`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input } })})`
		);
		assert.ok(!r.error, `${path}: ${JSON.stringify(r.error)}`);
		return r.result.data.json;
	};
	const click = (selector) =>
		js(
			`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Missing visible enabled control');e.click();})()`
		);
	const button = (scope, label) =>
		js(
			`(()=>{const es=[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].filter(e=>e.textContent.trim()===${JSON.stringify(label)}&&e.checkVisibility());if(es.length!==1||es[0].disabled)throw Error('Missing unique enabled button');es[0].click();})()`
		);
	const field = (text) =>
		js(
			`(()=>{const e=document.querySelector('textarea[name=question]');if(!e||!e.checkVisibility())throw Error('Missing typing');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
		);
	const turnUI = () =>
		js(
			`(()=>{const e=[...document.querySelectorAll('.exchange')].at(-1);return e?{turnId:e.dataset.turnId,phase:e.dataset.phase,answer:e.querySelector('.assistant-answer')?.getAttribute('data-answer'),visible:e.checkVisibility()}:null;})()`
		);
	async function submit(text) {
		const start = report.ipc.length;
		await field(text);
		await wait("enabled Send", () =>
			js(`!document.querySelector('[aria-label="Send message"]').disabled`)
		);
		await js("document.querySelector('textarea[name=question]').form.requestSubmit()");
		const ingress = await wait("actual typed ingress", () =>
			report.ipc.slice(start).find((r) => r.path === "conversation.start" && r.input.text === text)
		);
		assert.equal(ingress.input.inputMode, "typed");
		const ui = await wait("completed foreground turn", async () => {
			const u = await turnUI();
			if (u?.turnId !== ingress.input.turnId) return null;
			if (u.phase === "error") throw Error(`Foreground failed: ${text}`);
			return u.phase === "complete" && u;
		});
		assert.equal(ingress.rejected, false);
		return { ingress, ui, rows: report.ipc.slice(start) };
	}
	const step = async (label, work) => {
		const row = { label, status: "running" };
		report.checks.push(row);
		save();
		row.evidence = await work();
		row.status = "passed";
		save();
	};
	const captured = (source) =>
		wait("trusted intake and durable capture", () => provider.record(source.ts), 25000);
	const noAuthority = (source) => {
		const r = provider.record(source.ts);
		assert.ok(r);
		assert.ok(!r.item.clarification?.policy.standingAuthority);
		assert.ok(!standing().admissions.some((a) => a.source.messageId === source.ts));
		assert.equal(r.item.acceptance, "pending");
		assert.equal(r.item.jobId, null);
	};
	function child(source, parent) {
		const r = provider.record(source.ts);
		const c = r.item.clarification;
		assert.ok(c?.policy.standingAuthority);
		assert.equal(c.confirmedAt, null);
		assert.equal(c.expiresAt, parent.expiresAt);
		assert.equal(c.policy.standingAuthority.ruleId, parent.policy.id);
		assert.equal(c.policy.maxMessages, POLICY.messagesPerThread);
		assert.equal(c.policy.originalRequest, source.text);
		assert.equal(r.item.acceptance, "pending");
		assert.equal(r.item.jobId, null);
		assert.equal(r.item.answerReceipt, null);
		return r;
	}
	async function activate(label) {
		const proposal = await submit(`Propose a standing clarification rule for ${label}.`);
		const rule = standing().rules.at(-1);
		assert.equal(rule.status, "proposed");
		assert.equal(rule.confirmation, null);
		assert.equal(rule.expiresAt, null);
		assert.equal(proposal.ui.answer, canonical());
		assert.equal(proposal.ui.visible, true);
		const receipt = proposal.rows.find(
			(r) =>
				r.path === "conversation.narrationApplied" &&
				r.input.turnId === proposal.ingress.input.turnId &&
				r.input.status === "displayed" &&
				r.finishedAt &&
				!r.rejected
		);
		assert.ok(receipt, "Actual renderer narration receipt required");
		const checkpoint = report.checkpoints.find((a) => a.requestId === receipt.input.requestId);
		assert.ok(checkpoint, "Actual main checkpoint must precede renderer receipt");
		assert.equal(checkpoint.turnId, proposal.ingress.input.turnId);
		assert.equal(checkpoint.throughTextLength, canonical().length);
		assert.equal(report.posts.length, label === "first" ? 0 : 1);
		// All incoming sources before confirmation remain ordinary pending work.
		for (const r of day().records)
			if (!r.item.clarification?.policy.standingAuthority)
				noAuthority({ ts: r.item.source.source.messageId });
		await sleep(5); // Ensure the actual later user event is after publication, not a shared timestamp.
		const confirmation = await submit("yes");
		assert.notEqual(confirmation.ingress.input.turnId, proposal.ingress.input.turnId);
		assert.notEqual(confirmation.ingress.input.requestId, proposal.ingress.input.requestId);
		assert.ok(confirmation.ingress.at > receipt.finishedAt);
		const active = standing().rules.find((r) => r.policy.id === rule.policy.id);
		assert.equal(active.status, "active");
		assert.deepEqual(active.policy.actor, ACTOR);
		assert.equal(active.policy.channelId, CHANNEL);
		for (const [key, value] of Object.entries(POLICY)) assert.equal(active.policy[key], value);
		assert.equal(active.confirmation.requestId, confirmation.ingress.input.requestId);
		assert.equal(active.confirmation.policyDigest, digest(JSON.stringify(active.policy)));
		assert.equal(
			Date.parse(active.expiresAt) - Date.parse(active.confirmation.confirmedAt),
			300000
		);
		assert.ok(Date.parse(active.confirmation.confirmedAt) >= confirmation.ingress.at);
		report.publications ??= [];
		report.publications.push({
			ruleId: rule.policy.id,
			canonical: canonical(),
			proposalIngress: proposal.ingress.input,
			receipt: receipt.input,
			confirmationIngress: confirmation.ingress.input,
		});
		return active;
	}
	let old;
	let first;
	let delivered;
	let revokeChild;
	let expiryChild;
	await step("Isolated empty startup; real token import and selected Slack channel", async () => {
		assert.equal((await rpc("query", "app.config")).envPath, envPath);
		assert.deepEqual((await rpc("query", "day.snapshot")).items, []);
		assert.equal((await rpc("query", "hub.snapshot")).jobs.length, 0);
		writeConfig(TOKEN);
		await click('.command-rail button[aria-label="Settings"]');
		await wait("Settings", () => js("document.querySelector('#configuration')?.open"));
		const scope = '#configuration section[aria-label="Slack connection"]';
		await js(
			`(()=>{const e=[...document.querySelectorAll('${scope} summary')].find(e=>e.textContent==='Developer connection methods');if(!e)throw Error('Missing developer import');e.click();})()`
		);
		await button(scope, "Import .env Slack user token");
		await wait("verified account and membership", async () => {
			const s = await rpc("query", "slack.status");
			return (
				s.phase === "connected" &&
				s.account?.userId === ACTOR.userId &&
				s.membershipSync?.phase === "complete"
			);
		});
		await click('#configuration button[aria-label="Close settings"]');
		old = provider.add("prior to confirmation");
		await captured(old);
		noAuthority(old);
		await click('.command-rail button[aria-label^="Slack"]');
		await wait("channel in actual sidebar", () =>
			js("!!document.querySelector('.slack-conversation-row:not(:disabled)')")
		);
		await click(".slack-conversation-row");
		await wait("actual acknowledged Slack canvas", async () => {
			if (!(await js(`!!document.querySelector('[data-slack-target="${CHANNEL}"]')`))) return false;
			const sessionId = await js(
				"document.querySelector('main[data-session-id]').dataset.sessionId"
			);
			const s = await rpc("query", "workspace.observe", { sessionId });
			return s.workspace.canvases.some(
				(c) => c.id === s.workspace.primaryId && c.section === "slack" && c.selectedId === CHANNEL
			);
		});
		await click("[data-testid=workspace-more]");
		await wait("More dialog", () => js("document.querySelector('#workspace-more')?.open"));
		await click("[data-testid=conversation-toggle]");
		await wait("typing visible", () =>
			js("document.querySelector('textarea[name=question]')?.checkVisibility()")
		);
		return { priorMessage: old.ts };
	});
	await step(
		"Canonical proposal, actual displayed checkpoint, distinct typed confirmation and durable rule",
		async () => {
			first = await activate("first");
			noAuthority(old);
			return first;
		}
	);
	await step(
		"New trusted mention; durable original-thread controlled Slack send receipt",
		async () => {
			delivered = provider.add("after confirmation");
			await captured(delivered);
			const r = await wait(
				"delivered child ledger",
				() => {
					const r = provider.record(delivered.ts);
					return r?.outbox.some((o) => o.status === "delivered") && r;
				},
				30000
			);
			child(delivered, first);
			noAuthority(old);
			assert.ok(
				report.http.some((h) => h.kind === "classifier" && h.source.messageId === delivered.ts)
			);
			const admission = standing().admissions.find((a) => a.source.messageId === delivered.ts);
			assert.ok(admission);
			assert.equal(admission.expiresAt, first.expiresAt);
			assert.ok(Date.parse(admission.admittedAt) >= Date.parse(first.confirmation.confirmedAt));
			const attempt = r.item.clarification.attempts[0];
			const post = report.posts[0];
			assert.equal(attempt.status, "delivered");
			assert.equal(attempt.body, QUESTION);
			assert.equal(attempt.receipt.requestId, post.requestId);
			assert.equal(attempt.receipt.source.messageId, post.messageId);
			assert.equal(attempt.receipt.source.threadId, delivered.ts);
			assert.equal(attempt.receipt.bodyDigest, digest(QUESTION));
			return { admission, receipt: attempt.receipt };
		}
	);
	await step("Parent revoke fences admitted in-flight child and future mention", async () => {
		revokeChild = provider.add("revoke race");
		provider.hold(revokeChild.ts);
		await captured(revokeChild);
		await wait("held actual analysis HTTP", () => provider.held?.ts === revokeChild.ts);
		child(revokeChild, first);
		await submit(`revoke rule ${first.policy.id}`);
		assert.equal(standing().rules.find((r) => r.policy.id === first.policy.id).status, "revoked");
		provider.release();
		await wait(
			"revoked child cannot continue",
			() => provider.record(revokeChild.ts).item.clarification.status === "needs_user"
		);
		const late = provider.add("after revoke");
		await captured(late);
		noAuthority(late);
		noAuthority(old);
		assert.equal(report.posts.length, 1);
		return { revokedRule: first.policy.id, child: revokeChild.ts, late: late.ts };
	});
	await step("Real-clock parent expiry fences child and later incoming mention", async () => {
		const parent = await activate("expiry");
		const expires = Date.parse(parent.expiresAt);
		report.expiry = {
			confirmedAt: parent.confirmation.confirmedAt,
			expiresAt: parent.expiresAt,
			clockReplaced: false,
		};
		save();
		// The minimum production lifetime is five minutes. Never rewrite SQLite or replace Date.
		while (Date.now() < expires - 18000) {
			await sleep(Math.min(1000, expires - 18000 - Date.now()));
		}
		expiryChild = provider.add("expiry race");
		provider.hold(expiryChild.ts);
		await captured(expiryChild);
		await wait(
			"analysis held before real expiry",
			() => provider.held?.ts === expiryChild.ts,
			15000
		);
		assert.ok(Date.now() < expires, "Intake must reach analysis before expiry");
		child(expiryChild, parent);
		while (Date.now() <= expires) await sleep(100);
		provider.release();
		await wait(
			"expired child cannot continue",
			() => provider.record(expiryChild.ts).item.clarification.status === "needs_user"
		);
		const late = provider.add("after expiry");
		await captured(late);
		noAuthority(late);
		noAuthority(old);
		assert.equal(report.posts.length, 1);
		assert.equal(standing().admissions.length, 3);
		for (const source of [revokeChild, expiryChild])
			assert.equal(
				provider.record(source.ts).outbox.filter((o) => o.status === "delivered").length,
				0
			);
		return {
			parent,
			child: expiryChild.ts,
			late: late.ts,
			observedExpiredAt: new Date().toISOString(),
		};
	});
	assert.equal((await rpc("query", "hub.snapshot")).jobs.length, 0);
	assert.ok(!report.ipc.some((r) => r.input?.operation?.kind === "capture_manual"));
	assert.deepEqual(report.blocked, []);
}
module.exports = { run };
