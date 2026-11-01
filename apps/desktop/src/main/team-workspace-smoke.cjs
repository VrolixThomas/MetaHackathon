// ROOT ONLY after complete integration build: env -u ELECTRON_RUN_AS_NODE electron src/main/team-workspace-smoke.cjs [built-main]
// Author: node --check this-file; node this-file --self-check. No native/provider/DB launch in self-check.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { join, resolve } = require("node:path");
const { launch } = require("./team-workspace-smoke/runtime.cjs");
const {
	source,
	ORG,
	USER,
	PROPOSAL,
	VERSION,
	SECRET,
	digest,
	selfCheck,
} = require("./team-workspace-smoke/providers.cjs");

async function native() {
	const context = await launch();
	const {
		rpc,
		raw,
		js,
		click,
		step,
		wait,
		provider,
		report,
		fixture,
		envPath,
		userData,
		safeStorage,
	} = context;
	const button = async (container, text) => {
		await wait(`enabled Team control: ${text}`, () =>
			js(
				`[...document.querySelectorAll(${JSON.stringify(`${container} button`)})].some(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled)`
			)
		);
		return js(
			`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(`${container} button`)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Missing enabled Team control: '+${JSON.stringify(text)});e.click();})()`
		);
	};
	const openSettings = async () => {
		await click('[data-testid="workspace-more"]');
		await wait("More dialog", () => js(`document.querySelector('#workspace-more')?.open`));
		await click('[data-testid="configuration-toggle"]');
		await wait("actual Team Settings card", () =>
			js(
				`document.querySelector('#configuration')?.open&&!!document.querySelector('[data-team-card]')`
			)
		);
	};
	const closeSettings = async () => {
		await click("#configuration .workspace-dialog-heading button");
		await wait("Settings closed", () => js(`!document.querySelector('#configuration')`));
	};
	const assertPublic = async () => {
		const text = await js("document.body.innerText");
		const state = JSON.stringify(await rpc("query", "team.status", {}));
		for (const secret of Object.values(SECRET)) {
			assert.equal(text.includes(secret), false, "Provider credential exposed in renderer text");
			assert.equal(state.includes(secret), false, "Provider credential exposed in status");
		}
	};
	const encryptedFiles = () => {
		const directory = join(userData, "team");
		assert.ok(fs.existsSync(directory));
		return fs
			.readdirSync(directory, { recursive: true })
			.filter((name) => name.endsWith(".bin"))
			.map((name) => ({ name, bytes: fs.readFileSync(join(directory, name)) }));
	};
	try {
		await step(
			"active environment and actual SettingsTeamCard begin disconnected without product fallback",
			async () => {
				const config = await rpc("query", "app.config");
				assert.equal(config.envPath, envPath);
				assert.equal(config.configured.github, true);
				assert.equal(config.configured.elevenlabs, false);
				await openSettings();
				const state = await rpc("query", "team.status", {});
				assert.equal(state.configured, true);
				assert.equal(state.connection, "disconnected");
				assert.equal(state.userId, null);
				await wait("Connect team enabled", () =>
					js(
						`!![...document.querySelectorAll('[data-team-card] button')].find(e=>e.textContent.trim()==='Connect team'&&!e.disabled)`
					)
				);
				await assertPublic();
			}
		);
		await step(
			"actual TeamLogin PKCE callback and OS-encrypted session with real org/repository selection",
			async () => {
				await button("[data-team-card]", "Connect team");
				await wait("real facade connected status", async () => {
					const state = await rpc("query", "team.status", {});
					return state.connection === "connected" && state.userId === USER;
				});
				await wait("actual org choices", () =>
					js(
						`!!document.querySelector('select[aria-label="Team organization"] option[value="${ORG}"]')`
					)
				);
				await js(
					`(()=>{const e=document.querySelector('select[aria-label="Team organization"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(ORG)});e.dispatchEvent(new Event('change',{bubbles:true}));})()`
				);
				await wait("actual authorized repo choice", () =>
					js(
						`!![...document.querySelectorAll('[aria-label="Team repositories"] button')].find(e=>e.textContent.trim()==='Use shared preparation'&&!e.disabled)`
					)
				);
				await button('[aria-label="Team repositories"]', "Use shared preparation");
				await wait("selected persisted repository scope", async () => {
					const state = await rpc("query", "team.status", {});
					return state.scopes.some(
						(scope) =>
							scope.orgId === ORG &&
							scope.repositoryId === "42" &&
							scope.repository === source.repository &&
							scope.analysisVersion === VERSION
					);
				});
				assert.equal(provider.report.auth.length, 1);
				const files = encryptedFiles();
				const saved = files.find((file) => file.name.endsWith("session.bin"));
				assert.ok(saved);
				for (const secret of [SECRET.access, SECRET.refresh])
					assert.equal(saved.bytes.includes(Buffer.from(secret)), false);
				const session = JSON.parse(safeStorage.decryptString(saved.bytes));
				assert.equal(session.access_token, SECRET.access);
				assert.equal(session.refresh_token, SECRET.refresh);
				assert.ok(
					files.some(
						(file) =>
							file.name.endsWith("scopes.bin") &&
							safeStorage.decryptString(file.bytes).includes(source.repository)
					)
				);
				await assertPublic();
				await closeSettings();
				return { actualEncryptedSession: true, actualScopePersisted: true };
			}
		);
		await step(
			"root ReviewCoordinator reuses exact shared PreparedReview with no local preparation model call",
			async () => {
				await rpc("mutation", "reviews.connect", {
					repository: source.repository,
					localPath: fixture.localPath,
				});
				const ready = await wait(
					"shared prepared review accepted by actual coordinator",
					async () => {
						const inbox = await rpc("query", "reviews.inbox");
						const entry = inbox.items.find((item) => item.pr.id === source.prId);
						assert.notEqual(entry?.status, "error", entry?.error);
						return entry?.status === "ready" ? entry : null;
					}
				);
				assert.equal(ready.prepared.id, provider.review.id);
				assert.deepEqual(ready.prepared, provider.review);
				assert.equal(provider.report.modelCalls, 0);
				assert.ok(provider.report.team.some((row) => row.path === "/v1/reviews/read"));
				await click('[data-testid="repository-selector"]');
				await wait("actual inbox ready button", () =>
					js(
						`!!document.querySelector('[data-pr-id="${source.prId}"][data-review-status="ready"] button.review-inbox-select:not(:disabled)')`
					)
				);
				await click(`[data-pr-id="${source.prId}"] button.review-inbox-select`);
				const shown = await wait(
					"actual pinned shared-review source displayed and acknowledged",
					async () => {
						const state = await js(
							`(()=>{const r=document.querySelector('[aria-label="Prepared review"]'),m=document.querySelector('main[data-session-id]'),w=document.querySelector('.canvas-workspace');return r?{reviewId:r.dataset.reviewId,path:r.dataset.reviewPath,head:r.dataset.headSha,base:r.dataset.baseSha,loading:r.dataset.reviewLoading,sessionId:m?.dataset.sessionId,sequence:Number(w?.dataset.workspaceSequence),text:[...r.querySelectorAll('.source-row code')].map(e=>e.textContent).join(String.fromCharCode(10))}:null})()`
						);
						if (!state || state.reviewId !== provider.review.id || state.loading !== "false")
							return null;
						const observation = await rpc("query", "workspace.observe", {
							sessionId: state.sessionId,
						});
						return observation.workspace.sequence === state.sequence &&
							observation.workspace.review.reviewId === provider.review.id
							? state
							: null;
					}
				);
				assert.equal(shown.head, fixture.headSha);
				assert.equal(shown.base, fixture.baseSha);
				assert.equal(shown.path, source.order[0]);
				assert.ok(
					report.ipc.some(
						(row) =>
							row.path === "workspace.applied" &&
							row.input.status === "applied" &&
							row.result?.result?.data?.json?.status === "accepted" &&
							row.input.workspace?.review.reviewId === provider.review.id
					)
				);
				assert.ok(
					encryptedFiles().some(
						(file) =>
							file.name.endsWith("cache.bin") &&
							safeStorage.decryptString(file.bytes).includes(provider.review.id)
					)
				);
				return {
					preparedId: ready.prepared.id,
					localModelCalls: provider.report.modelCalls,
					shown,
				};
			}
		);
		await step(
			"actual shared proposal renders exact Before/After/patch/hash and requires explicit decision",
			async () => {
				await openSettings();
				await wait("Team card connected", () =>
					js(
						`document.querySelector('[data-testid="team-status"]')?.textContent.includes('Connected')`
					)
				);
				await button("[data-team-card]", "Refresh proposals");
				await wait("actual shared proposal list", () =>
					js(`!!document.querySelector('.team-proposal-list button:not(:disabled)')`)
				);
				await click(".team-proposal-list button");
				await wait("actual exact proposal detail", () =>
					js(`!!document.querySelector('[data-team-proposal="${PROPOSAL}"]')`)
				);
				await js(
					`document.querySelector('[data-team-proposal="${PROPOSAL}"]').scrollIntoView({block:"start"})`
				);
				const proposal = provider.proposal;
				assert.ok(proposal);
				const frames = await js(
					`new Promise(resolve=>requestAnimationFrame(()=>{const read=()=>{const e=document.querySelector('[data-team-proposal="${PROPOSAL}"]');return {id:e?.dataset.teamProposal,digest:e?.dataset.teamBundleDigest,before:e?.querySelector('[data-team-source-side="before"] code')?.textContent,after:e?.querySelector('[data-team-source-side="after"] code')?.textContent,beforeSha:e?.querySelector('[data-team-source-side="before"]')?.dataset.teamSourceSha,afterSha:e?.querySelector('[data-team-source-side="after"]')?.dataset.teamSourceSha,patch:e?.querySelector('[data-team-patch] code')?.textContent,visible:e?.checkVisibility(),acceptDisabled:[...e.querySelectorAll('button')].find(b=>b.textContent.trim()==='Accept proposal')?.disabled};};const a=read();requestAnimationFrame(()=>resolve([a,read()]));}))`
				);
				for (const frame of frames) {
					assert.equal(frame.visible, true);
					assert.equal(frame.digest, digest(proposal.bundle));
					assert.equal(frame.before, proposal.bundle.files[0].before.text);
					assert.equal(frame.after, proposal.bundle.files[0].after.text);
					assert.equal(frame.beforeSha, proposal.bundle.baseSha);
					assert.equal(frame.afterSha, proposal.bundle.candidateSha);
					assert.equal(frame.patch, proposal.bundle.patch.text);
					assert.equal(frame.acceptDisabled, true);
				}
				assert.equal(provider.report.decisions.length, 0);
				const proposalScreenshot = join(__dirname, "../../out/team-proposal-controlled.png");
				fs.writeFileSync(proposalScreenshot, (await context.win.webContents.capturePage()).toPNG());
				report.proposalScreenshot = proposalScreenshot;
				const invalid = await raw("mutation", "team.decideProposal", {
					proposalId: PROPOSAL,
					repository: source.repository,
					bundleDigest: "0".repeat(64),
					decision: "accept",
					requestId: "60000000-0000-4000-8000-000000000001",
					confirmed: true,
				});
				assert.ok(invalid.error, "Wrong digest must reject in actual main facade");
				assert.equal(provider.report.decisions.length, 0);
				await click('[data-team-proposal] .team-confirm input[type="checkbox"]');
				await button("[data-team-proposal]", "Accept proposal");
				await wait("actual decision recorded and shown", () =>
					js(
						`document.querySelector('[data-team-proposal]')?.textContent.includes('Author decision: accepted.')`
					)
				);
				assert.equal(provider.report.decisions.length, 1);
				const decision = provider.report.decisions[0];
				assert.equal(decision.bundle_digest, proposal.bundle_digest);
				assert.equal(decision.author_id, USER);
				assert.equal(decision.proposal_id, PROPOSAL);
				const attempt = report.ipc.find(
					(row) =>
						row.path === "team.decideProposal" && row.input.bundleDigest === proposal.bundle_digest
				);
				assert.ok(attempt);
				assert.equal(attempt.input.confirmed, true);
				assert.equal(attempt.input.requestId, decision.request_id);
				const retry = await rpc("mutation", "team.decideProposal", attempt.input);
				assert.equal(retry.status, "recorded");
				assert.equal(provider.report.decisions.length, 1);
				await assertPublic();
				return {
					proposalId: proposal.id,
					bundleDigest: proposal.bundle_digest,
					exactVisibleFrames: frames.length,
					decisionId: decision.id,
					requestId: decision.request_id,
				};
			}
		);
		await step(
			"accepted exact proposal applies through actual isolated runtime checks and enters Completed work",
			async () => {
				await rpc("mutation", "hub.operate", {
					requestId: randomUUID(),
					operation: {
						kind: "add-repository",
						repository: source.repository,
						localPath: fixture.localPath,
					},
				});
				await js(
					`(()=>{const label=[...document.querySelectorAll('[data-team-proposal] label')].find(e=>e.textContent.includes('Apply this accepted fix locally.'));if(!label)throw Error('Application consent missing');label.querySelector('input').click();})()`
				);
				await button("[data-team-proposal]", "Apply accepted fix locally");
				const result = await wait(
					"actual local apply receipt",
					async () => {
						const attempt = report.ipc.find(
							(row) => row.path === "team.applyProposal" && row.completed
						);
						if (!attempt) return null;
						assert.ok(!attempt.result.error, JSON.stringify(attempt.result.error));
						const value = attempt.result.result.data.json;
						assert.equal(value.status, "applied", JSON.stringify(value));
						return value;
					},
					60000
				);
				assert.ok(result.jobId);
				const applied = await rpc("query", "hub.reviewWork", { jobId: result.jobId });
				assert.equal(applied.job.headSha, result.appliedHeadSha);
				assert.equal(applied.job.codingProvider.provider, "muse-code");
				assert.equal(applied.job.codingProvider.musePath, "/controlled/missing-muse-cli");
				const queue = await rpc("query", "hub.snapshot", {});
				assert.ok(
					queue.notices.some(
						(notice) =>
							notice.kind === "work-ready" &&
							notice.jobId === result.jobId &&
							notice.headSha === result.appliedHeadSha &&
							notice.announcedAt === null
					)
				);
				assert.ok(applied.job.checks.length > 0);
				assert.ok(
					applied.job.checks.every(
						(check) => check.exitCode === 0 && check.commitSha === result.appliedHeadSha
					)
				);
				assert.equal(applied.files[0].head.content, provider.proposal.bundle.files[0].after.text);
				assert.equal(source.git(fixture.localPath, "status", "--porcelain=v1"), fixture.status);
				assert.equal(fs.readFileSync(join(fixture.localPath, "a-logic.ts"), "utf8"), fixture.dirty);
				await button("[data-team-card]", "Review applied fix");
				await wait("applied job visible in Completed work", () =>
					js(
						`!!document.querySelector('[data-center-section="completed"][data-selected-id="${result.jobId}"]')`
					)
				);
				await button('[data-center-section="completed"]', "Inspect local diff");
				await wait("actual applied source diff rendered", () =>
					js(
						`document.querySelector('.hub-work-review')?.textContent.includes('Math.max(0, quote.discount)')`
					)
				);
				const appliedScreenshot = join(__dirname, "../../out/team-application-controlled.png");
				fs.writeFileSync(appliedScreenshot, (await context.win.webContents.capturePage()).toPNG());
				report.applicationScreenshot = appliedScreenshot;
				await openSettings();
				return {
					appliedHeadSha: result.appliedHeadSha,
					checks: applied.job.checks.length,
					retainedOriginal: true,
				};
			}
		);
		await step(
			"actual disconnect removes encrypted session and retires current team detail",
			async () => {
				await button("[data-team-card]", "Disconnect team");
				await wait(
					"actual team disconnect",
					async () => (await rpc("query", "team.status", {})).connection === "disconnected"
				);
				await wait("old proposal removed from Settings", () =>
					js(`!document.querySelector('[data-team-proposal]')`)
				);
				assert.equal(
					encryptedFiles().some((file) => file.name.endsWith("session.bin")),
					false
				);
				assert.equal(provider.report.modelCalls, 0);
				assert.equal(report.providerError, undefined);
				assert.deepEqual(report.blocked, []);
				assert.deepEqual(report.permissions, []);
				await assertPublic();
			}
		);
		await context.stop();
	} catch (error) {
		await context.stop(error);
	}
}
if (
	require.main === module ||
	(process.versions.electron && process.argv[1] && resolve(process.argv[1]) === resolve(__filename))
) {
	Promise.resolve()
		.then(() => (process.argv.includes("--self-check") ? selfCheck() : native()))
		.catch((error) => {
			console.error(error.stack ?? error.message);
			process.exitCode = 1;
		});
}
