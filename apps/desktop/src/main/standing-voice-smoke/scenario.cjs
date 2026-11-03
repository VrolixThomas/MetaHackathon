const assert = require("node:assert/strict");
const H = require("../standing-clarification-smoke/provider.cjs");
const { CHANNEL, ACTOR, POLICY, QUESTION, digest, canonical } = H;
const { key } = require("./media.cjs");
async function run({
	js,
	wait,
	report,
	save,
	writeConfig,
	TOKEN,
	envPath,
	day,
	standing,
	provider,
	mediaTransport: M,
}) {
	const rpc = async (type, path, input = {}) => {
		assert.ok(
			!["conversation.start", "conversation.narrationApplied"].includes(path),
			"Harness cannot manufacture ingress/receipt"
		);
		const r = await js(
			`window.electron.trpc.request(${JSON.stringify({ type, path, input: { json: input } })})`
		);
		assert.ok(!r.error, `${path}: ${JSON.stringify(r.error)}`);
		return r.result.data.json;
	};
	const click = (selector) =>
		js(
			`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||!e.checkVisibility())throw Error('Missing enabled visible control '+${JSON.stringify(selector)});e.click()})()`
		);
	const button = (scope, label) =>
		js(
			`(()=>{const es=[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].filter(e=>e.textContent.trim()===${JSON.stringify(label)}&&e.checkVisibility());if(es.length!==1||es[0].disabled)throw Error('Missing unique button');es[0].click()})()`
		);
	const step = async (label, work) => {
		const row = { label, status: "running" };
		report.checks.push(row);
		save();
		row.evidence = await work();
		row.status = "passed";
		save();
	};
	const captured = (source) => wait("trusted incoming capture", () => provider.record(source.ts));
	const noAuthority = (source) => {
		const r = provider.record(source.ts);
		assert.ok(r);
		assert.ok(!r.item.clarification?.policy.standingAuthority);
		assert.ok(!standing().admissions.some((a) => a.source.messageId === source.ts));
		assert.equal(r.item.acceptance, "pending");
		assert.equal(r.item.jobId, null);
	};
	let old;
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
		return { priorMessage: old.ts };
	});
	await step("Actual hands-free Start and controlled Chromium microphone", async () => {
		assert.equal(
			(await rpc("query", "app.config")).microphone,
			"granted",
			"Actual app microphone permission required"
		);
		await wait(
			"actual voice manager ready",
			async () => {
				const v = await rpc("query", "voice.status");
				assert.notEqual(v.phase, "error", v.error);
				return v.phase === "ready";
			},
			50000
		);
		await M.install();
		await click('[data-testid="voice-control"][aria-label="Start conversation"]');
		await wait("persistent listening", () =>
			js("document.querySelector('footer.voice-bar')?.dataset.handsFree==='true'")
		);
		await wait("actual capture worklet", async () =>
			(await M.media()).worklets.some((w) => w.name === "voice-hands-free" && w.frames > 5)
		);
		return { syntheticMicrophone: true, liveAcoustics: false };
	});
	const spoken = (t) =>
		report.ipc.find(
			(r) =>
				r.path === "conversation.narrationApplied" &&
				r.input.turnId === t.input.turnId &&
				r.input.status === "spoken" &&
				r.finishedAt &&
				!r.rejected
		);
	async function utter(text) {
		const start = report.ipc.length;
		M.enqueue(text);
		const waveform = await js("window.__handsSmoke.drive([[700,900]])");
		const ingress = await wait("actual ASR-to-conversation ingress", () =>
			report.ipc.slice(start).find((r) => r.path === "conversation.start" && r.input.text === text)
		);
		assert.equal(ingress.input.inputMode, "voice");
		const release = report.releases.find((r) => key(r) === key(ingress.input));
		assert.ok(release);
		assert.ok(release.at <= ingress.at);
		const session = M.sessions.get(key(ingress.input));
		assert.ok(session);
		return { ingress, session, waveform };
	}
	async function playing(t) {
		return wait("actual decoded TTS PCM", async () => {
			const s = t.session;
			const o = M.output(await M.media(), s);
			return (
				s.speechId &&
				!s.cancelled &&
				!Number.isFinite(s.endedAt) &&
				o?.nonSilent > (s.pcmBefore ?? 0) + 4 &&
				o
			);
		});
	}
	async function finish(t, expectReceipt = true) {
		await wait("voice turn settles after actual PCM drain", async () => {
			const s = t.session;
			if (s.speechId && !s.cancelled && !Number.isFinite(s.endedAt)) {
				const o = M.output(await M.media(), s);
				if (o?.nonSilent > (s.pcmBefore ?? 0) + 4) await M.end(s);
			}
			if (expectReceipt) return spoken(t.ingress);
			return (
				(await M.media()).peers[s.local].state === "closed" &&
				(report.polls?.findLast(
					(r) =>
						r.turnId === t.ingress.input.turnId &&
						["completed", "error", "cancelled"].includes(r.status)
				) ||
					(["error", "cancelled"].includes(t.ingress.result?.status) && t.ingress.result))
			);
		});
	}
	async function stop(t) {
		await click('[aria-label="Stop response"]');
		await wait("foreground cancellation RPC", () =>
			report.ipc.some(
				(r) => r.path === "conversation.cancel" && r.input.turnId === t.ingress.input.turnId
			)
		);
		await wait("cancelled actual media", () => t.session.cancelled);
		assert.equal(await js("document.querySelector('footer.voice-bar')?.dataset.handsFree"), "true");
	}
	await step("Interrupted proposal cannot authorize later actual voice yes", async () => {
		const t = await utter("Propose a standing clarification rule for interrupted voice.");
		await playing(t);
		const rule = standing().rules.at(-1);
		assert.equal(rule.status, "proposed");
		assert.equal(rule.confirmation, null);
		assert.ok(!spoken(t.ingress));
		await stop(t);
		const yes = await utter("yes");
		await finish(yes, false);
		assert.ok(
			report.http.some(
				(r) =>
					r.kind === "foreground" &&
					r.tool === "standing_clarification_confirm" &&
					r.at >= yes.ingress.at
			),
			"Negative yes must reach the real confirmation tool"
		);
		assert.ok(!spoken(t.ingress));
		assert.equal(standing().rules.find((r) => r.policy.id === rule.policy.id).status, "proposed");
		assert.equal(standing().rules.filter((r) => r.status === "active").length, 0);
		assert.equal(report.posts.length, 0);
		return {
			proposal: t.ingress.input,
			interruptedRule: rule,
			confirmation: yes.ingress.input,
			after: standing(),
		};
	});
	let active;
	await step(
		"Exact canonical TTS, actual drain and distinct voice confirmation activate durable rule",
		async () => {
			const t = await utter("Propose a standing clarification rule for genuine voice.");
			await playing(t);
			const rule = standing().rules.at(-1);
			assert.equal(rule.status, "proposed");
			assert.ok(!spoken(t.ingress));
			assert.equal(rule.confirmation, null);
			await finish(t);
			const receipt = spoken(t.ingress);
			assert.equal(t.session.texts.join(" "), canonical());
			const checkpoint = report.checkpoints.find((c) => c.requestId === receipt.input.requestId);
			assert.equal(checkpoint.throughTextLength, canonical().length);
			assert.equal(checkpoint.turnId, t.ingress.input.turnId);
			assert.equal(standing().rules.find((r) => r.policy.id === rule.policy.id).status, "proposed");
			const yes = await utter("yes");
			await finish(yes, false);
			assert.notEqual(yes.ingress.input.turnId, t.ingress.input.turnId);
			assert.notEqual(yes.ingress.input.requestId, t.ingress.input.requestId);
			assert.ok(yes.ingress.at > receipt.finishedAt);
			active = standing().rules.find((r) => r.policy.id === rule.policy.id);
			assert.equal(active.status, "active");
			assert.deepEqual(active.policy.actor, ACTOR);
			assert.equal(active.policy.channelId, CHANNEL);
			for (const [k, v] of Object.entries(POLICY)) assert.equal(active.policy[k], v);
			assert.equal(active.confirmation.requestId, yes.ingress.input.requestId);
			assert.equal(active.confirmation.policyDigest, digest(JSON.stringify(active.policy)));
			assert.equal(
				Date.parse(active.expiresAt) - Date.parse(active.confirmation.confirmedAt),
				300000
			);
			noAuthority(old);
			return {
				canonical: canonical(),
				proposal: t.ingress.input,
				checkpoint,
				receipt,
				confirmation: yes.ingress.input,
				active,
			};
		}
	);
	await step(
		"Speech Stop retains admitted background clarification and original-thread delivery",
		async () => {
			const source = provider.add("fresh after actual voice confirmation");
			provider.hold(source.ts);
			await captured(source);
			await wait("independent background analysis held", () => provider.held?.ts === source.ts);
			const admission = standing().admissions.find((a) => a.source.messageId === source.ts);
			assert.ok(admission);
			assert.equal(admission.expiresAt, active.expiresAt);
			assert.ok(Date.parse(admission.admittedAt) >= Date.parse(active.confirmation.confirmedAt));
			// A new proposal is harmless and provides real foreground speech to stop while
			// the independently admitted child remains held in its real model transport.
			const t = await utter("Propose a standing clarification rule for stop continuity.");
			await playing(t);
			M.enqueue("Stop");
			await js("window.__handsSmoke.drive([[700,900]])");
			const stopRelease = await wait("actual spoken Stop ASR release", () =>
				report.releases.findLast((r) => r.text === "Stop")
			);
			await wait("spoken Stop cancels foreground media", () => t.session.cancelled);
			await wait("spoken Stop consumed and its media cancelled", () =>
				report.ipc.some(
					(r) => r.path === "voice.cancel" && key(r.input) === key(stopRelease) && r.finishedAt
				)
			);
			assert.equal(
				report.ipc.some((r) => r.path === "conversation.start" && r.input.text === "Stop"),
				false
			);
			assert.equal(
				await js("document.querySelector('footer.voice-bar')?.dataset.handsFree"),
				"true"
			);
			assert.equal(provider.held?.ts, source.ts);
			assert.deepEqual(
				standing().admissions.find((a) => a.source.messageId === source.ts),
				admission
			);
			provider.release();
			const record = await wait("durable original-thread provider delivery", () => {
				const r = provider.record(source.ts);
				return r?.outbox.some((o) => o.status === "delivered") && r;
			});
			const c = record.item.clarification;
			assert.equal(c.policy.standingAuthority.ruleId, active.policy.id);
			assert.equal(c.policy.maxMessages, POLICY.messagesPerThread);
			assert.equal(c.policy.originalRequest, source.text);
			assert.equal(c.confirmedAt, null);
			assert.equal(c.expiresAt, active.expiresAt);
			assert.equal(record.item.acceptance, "pending");
			assert.equal(record.item.jobId, null);
			assert.equal(record.item.answerReceipt, null);
			assert.equal(report.posts.length, 1);
			const attempt = c.attempts[0];
			const post = report.posts[0];
			assert.equal(attempt.status, "delivered");
			assert.equal(attempt.body, QUESTION);
			assert.equal(attempt.receipt.requestId, post.requestId);
			assert.equal(attempt.receipt.source.messageId, post.messageId);
			assert.equal(attempt.receipt.source.threadId, source.ts);
			assert.equal(attempt.receipt.bodyDigest, digest(QUESTION));
			noAuthority(old);
			return { source, admission, stoppedTurn: t.ingress.input, stopRelease, record, post };
		}
	);
	await click('[data-testid="voice-control"][aria-label="End conversation"]');
	await wait("microphone ended", async () =>
		(await M.media()).microphones.every((m) => m.state === "ended")
	);
	report.finalMedia = await M.media();
	await js("window.__handsSmoke.dispose()");
	assert.deepEqual(report.blocked, []);
}
module.exports = { run };
