import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RuntimeService } from "./service";

test("owned base/head previews execute interactive pricing and retain real pinned source identity", async () => {
	const root = await mkdtemp(join(tmpdir(), "browser-preview-"));
	const runtime = new RuntimeService({
		userDataPath: root,
		fixturesPath: resolve("fixtures/demo"),
		encryption: {
			isEncryptionAvailable: () => false,
			encryptString: () => {
				throw Error("Unavailable");
			},
			decryptString: () => {
				throw Error("Unavailable");
			},
		},
		submissionLedger: { reserve: () => undefined, complete: () => {} },
		// Geometry is mocked; HTTP, Git checkout, pricing and shutdown below are actual execution.
		createPreviewPage: () => ({
			async loadURL() {},
			async setViewport() {},
			async measure() {
				return [
					{ id: "cap-note", x: 0, y: 10, width: 100, height: 20 },
					{ id: "pay-button", x: 0, y: 900, width: 100, height: 40 },
				];
			},
			close() {},
		}),
	});
	const urls: string[] = [];
	try {
		const prs = await runtime.prepareDemo();
		const pr = prs.find((pr) => pr.repository === "demo/shop-web");
		assert.ok(pr);
		for (const revision of ["head", "base"] as const) {
			const preview = await runtime.startPreview(`open-${revision}`, pr.id, "desktop", revision);
			const lease = { ...preview, close: () => runtime.stopPreview(preview.id) };
			urls.push(lease.url);
			assert.equal(lease.revision, revision);
			assert.equal(lease.commitSha, revision === "head" ? pr.headSha : pr.baseSha);
			const initial = await (await fetch(lease.url)).text();
			assert.match(initial, revision === "head" ? /€72\.00/ : /€84\.00/);
			assert.match(initial, /<form method="get" action="\/checkout">/);
			const promo = new URL(lease.url);
			promo.searchParams.set("promo", "SPRING15");
			assert.match(await (await fetch(promo)).text(), revision === "head" ? /€78\.00/ : /€102\.00/);
			promo.searchParams.set("promo", '<script>alert("secret")</script>');
			const invalid = await (await fetch(promo)).text();
			assert.match(invalid, /Error 422/);
			assert.ok(!invalid.includes("<script>alert("));
			assert.match(invalid, /&lt;script&gt;/);
			const cart = new URL(lease.url);
			cart.pathname = "/cart";
			assert.match(await (await fetch(cart)).text(), /Continue to checkout/);
			cart.searchParams.delete("runId");
			assert.equal((await fetch(cart)).status, 404);
			await lease.close();
			await assert.rejects(fetch(lease.url));
		}
	} finally {
		await runtime.dispose();
		await rm(root, { recursive: true, force: true });
	}
	for (const url of urls) await assert.rejects(fetch(url));
});
