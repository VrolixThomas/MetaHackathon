import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
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
		assert.match(after.content ?? "", /no expiry or invalidation/);
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
		await service.dispose();
		await rm(root, { recursive: true });
	}
});
