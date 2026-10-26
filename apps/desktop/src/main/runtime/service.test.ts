import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createRuntimeRouter } from "./router";
import { RuntimeService } from "./service";

test("runtime router prepares actual demo refs, serves their source/diff and executes Scenario C", async () => {
	const root = await mkdtemp(join(tmpdir(), "runtime-service-"));
	const service = new RuntimeService({
		userDataPath: root,
		fixturesPath: resolve("fixtures/demo"),
		encryption: {
			isEncryptionAvailable: () => false,
			encryptString: () => {
				throw Error("unavailable");
			},
			decryptString: () => {
				throw Error("unavailable");
			},
		},
		submissionLedger: { reserve: () => undefined, complete: () => {} },
		createPreviewPage: () => {
			throw Error("This test does not create a preview page");
		},
	});
	const caller = createRuntimeRouter(() => service).createCaller({});
	try {
		const [prs, duplicate] = await Promise.all([caller.prepareDemo(), caller.prepareDemo()]);
		assert.deepEqual(prs, duplicate);
		const shop = prs.find((pr) => pr.id === "demo/shop-web#1284");
		assert.ok(shop);
		assert.notEqual(shop.baseSha, "1".repeat(40));
		const files = await caller.changedFiles({ prId: shop.id });
		assert.ok(files.includes("promo/PromoCache.ts"));
		const before = await caller.source({
			prId: shop.id,
			revision: "base",
			path: "promo/PromoCache.ts",
		});
		const after = await caller.source({
			prId: shop.id,
			revision: "head",
			path: "promo/PromoCache.ts",
		});
		assert.equal(before.content, null);
		assert.equal(before.prId, shop.id);
		assert.match(after.content ?? "", /no expiry or invalidation/);
		await assert.rejects(
			caller.source({ prId: shop.id, revision: "head", path: "pricing" }),
			/not a file/
		);
		const prepared = service.getPrepared(shop.id);
		const originalSha = prepared.pr.headSha;
		prepared.pr.headSha = "f".repeat(40);
		await assert.rejects(
			caller.source({ prId: shop.id, revision: "head", path: "pricing/applyDiscounts.ts" }),
			/Could not inspect/
		);
		prepared.pr.headSha = originalSha;
		assert.deepEqual(
			(await caller.credentialStatus()).map((status) => status.provider),
			["github", "meta", "elevenlabs"]
		);
		await assert.rejects(
			caller.setCredential({ provider: "meta", secret: `${" ".repeat(20_000)}x` }),
			(error: unknown) => (error as { code?: string }).code === "BAD_REQUEST"
		);
		const diff = await caller.diff({ prId: shop.id, path: "pricing/applyDiscounts.ts" });
		assert.match(diff.patch, /throw new PromoExpiredError/);
		const run = await caller.runScenario({
			requestId: "service-scenario-c",
			prId: shop.id,
			scenarioId: "C",
		});
		assert.equal(run.trace.after.commitSha, shop.headSha);
		assert.equal(run.trace.after.evidence.kind, "execution");
		assert.equal((run.results.head as { batchStopped: boolean }).batchStopped, true);
		await assert.rejects(caller.source({ prId: shop.id, revision: "head", path: "../outside" }));
		assert.deepEqual(await caller.cancel({ requestId: "not-running" }), { cancelled: false });
		assert.equal("getCredential" in caller, false);
	} finally {
		await Promise.all([service.dispose(), service.dispose()]);
		await rm(root, { recursive: true });
	}
});

test("cancellation during preview measurement rejects and closes the owned server", async () => {
	const root = await mkdtemp(join(tmpdir(), "runtime-preview-cancel-"));
	let pageClosed = false;
	let previewUrl = "";
	let service: RuntimeService;
	service = new RuntimeService({
		userDataPath: root,
		fixturesPath: resolve("fixtures/demo"),
		encryption: {
			isEncryptionAvailable: () => false,
			encryptString: () => {
				throw Error("unavailable");
			},
			decryptString: () => {
				throw Error("unavailable");
			},
		},
		submissionLedger: { reserve: () => undefined, complete: () => {} },
		createPreviewPage: () => ({
			async loadURL(url) {
				previewUrl = url;
			},
			async setViewport() {},
			async measure() {
				service.cancel("cancel-during-measure");
				return [
					{ id: "cap-note", x: 1, y: 1, width: 10, height: 10 },
					{ id: "pay-button", x: 1, y: 20, width: 10, height: 10 },
				];
			},
			close() {
				pageClosed = true;
			},
		}),
	});
	try {
		await service.prepareDemo();
		await assert.rejects(
			service.startPreview("cancel-during-measure", "demo/shop-web#1284", "phone"),
			/cancelled/
		);
		assert.equal(pageClosed, true);
		assert.ok(previewUrl.startsWith("http://127.0.0.1:"));
		await assert.rejects(fetch(previewUrl, { signal: AbortSignal.timeout(2000) }));
	} finally {
		await service.dispose();
		await rm(root, { recursive: true });
	}
});

test("shutdown aborts and awaits direct main-only generated-test calls before removing worktrees", async () => {
	const root = await mkdtemp(join(tmpdir(), "runtime-direct-runner-"));
	const service = new RuntimeService({
		userDataPath: root,
		fixturesPath: resolve("fixtures/demo"),
		encryption: {
			isEncryptionAvailable: () => false,
			encryptString: () => {
				throw Error("unused");
			},
			decryptString: () => {
				throw Error("unused");
			},
		},
		submissionLedger: { reserve: () => undefined, complete: () => {} },
		createPreviewPage: () => {
			throw Error("unused");
		},
	});
	try {
		await service.prepareDemo();
		const prepared = service.getPrepared("demo/shop-web#1284");
		const running = service.scenarios.runGeneratedTest({
			...prepared,
			title: "Long test",
			filename: "long.mjs",
			source: "setInterval(()=>{},1000)",
			timeoutMs: 30_000,
		});
		const outcome = running.then(
			() => "completed",
			() => "cancelled"
		);
		await delay(100);
		const started = performance.now();
		await service.dispose();
		assert.ok(performance.now() - started < 3000);
		assert.equal(await outcome, "cancelled");
		await assert.rejects(
			service.scenarios.runScenario({
				...prepared,
				scenarioId: "C",
				title: "After shutdown",
				timeoutMs: 1000,
			}),
			/shut down/
		);
	} finally {
		await service.dispose();
		await rm(root, { recursive: true });
	}
});

test("preview stop removes detached helpers with inherited pipes and settles promptly", async () => {
	const root = await mkdtemp(join(tmpdir(), "runtime-preview-helper-"));
	const fixturePath = join(root, "fixture");
	await cp(resolve("fixtures/demo"), fixturePath, { recursive: true });
	const serverPath = join(fixturePath, "shop-web/base/checkout/server.mjs");
	const pidFile = join(root, "helper.pid");
	await writeFile(
		serverPath,
		`${await readFile(serverPath, "utf8")}\nimport{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const helper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});writeFileSync(${JSON.stringify(pidFile)},String(helper.pid));`
	);
	const service = new RuntimeService({
		userDataPath: join(root, "data"),
		fixturesPath: fixturePath,
		encryption: {
			isEncryptionAvailable: () => false,
			encryptString: () => {
				throw Error("unused");
			},
			decryptString: () => {
				throw Error("unused");
			},
		},
		submissionLedger: { reserve: () => undefined, complete: () => {} },
		createPreviewPage: () => ({
			async loadURL() {},
			async setViewport() {},
			async measure() {
				return [
					{ id: "cap-note", x: 1, y: 1, width: 10, height: 10 },
					{ id: "pay-button", x: 1, y: 700, width: 10, height: 10 },
				];
			},
			close() {},
		}),
	});
	let helperPid = 0;
	try {
		await service.prepareDemo();
		const preview = await service.startPreview("helper", "demo/shop-web#1284", "phone");
		helperPid = Number(await readFile(pidFile, "utf8"));
		assert.ok(helperPid > 0);
		const started = performance.now();
		await service.stopPreview(preview.id);
		assert.ok(performance.now() - started < 1500);
		assert.throws(() => process.kill(helperPid, 0));
		await assert.rejects(fetch(preview.url));
	} finally {
		if (helperPid) {
			try {
				process.kill(-helperPid, "SIGKILL");
			} catch {
				/* Already cleaned. */
			}
		}
		await service.dispose();
		await rm(root, { recursive: true });
	}
});
