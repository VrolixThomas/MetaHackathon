/** Standalone validation entrypoint; bundle with esbuild and run with Electron, never import in app lifecycle. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { app, safeStorage } from "electron";
import type { PullRequest } from "../../shared/contracts";
import { RuntimeState } from "../db/runtime-state";
import { CredentialStore } from "./credentials";
import { seedDemoRepositories } from "./demo";
import { GitHubClient } from "./github";
import { PreviewRunner } from "./preview";
import { createElectronPreviewPage } from "./preview-electron";
import { RepositoryManager } from "./repositories";
import { ScenarioRunner } from "./scenarios";

async function main() {
	const output = resolve(
		process.env["METAHACKATHON_SMOKE_OUTPUT"] ?? join(tmpdir(), "metahackathon-runtime-smoke")
	);
	await mkdir(output, { recursive: true });
	const root = await mkdtemp(join(output, "run-"));
	app.setPath("userData", join(root, "user-data"));
	await mkdir(app.getPath("userData"), { recursive: true });
	app.on("window-all-closed", () => {});
	await app.whenReady();
	const report: Record<string, unknown> = {
		root,
		startedAt: new Date().toISOString(),
		electron: process.versions.electron,
		node: process.versions.node,
	};
	const seed = await seedDemoRepositories(
		root,
		resolve(process.env["METAHACKATHON_FIXTURES"] ?? "fixtures/demo")
	);
	const manager = new RepositoryManager(join(root, "worktrees"));
	const trees = await manager.prepare({
		repositoryPath: seed.shop.path,
		baseRef: seed.shop.baseSha,
		headRef: seed.shop.headSha,
	});
	const previews = new PreviewRunner(join(root, "logs"), createElectronPreviewPage);
	const database = new Database(":memory:");
	try {
		const pr: PullRequest = {
			id: "demo/shop-web#1284",
			repository: "demo/shop-web",
			number: 1284,
			title: "Stackable promo codes at checkout",
			author: "Noor",
			url: "https://example.invalid/demo/shop-web/pull/1284",
			baseSha: seed.shop.baseSha,
			headSha: seed.shop.headSha,
		};
		report["pr"] = pr;
		const scenarios = new ScenarioRunner(join(root, "logs"));
		const scenarioC = await scenarios.runScenario({
			pr,
			worktrees: trees,
			scenarioId: "C",
			title: "Expired promo stops the nightly reminder batch",
			timeoutMs: 15_000,
		});
		assert.equal((scenarioC.results.head as { batchStopped: boolean }).batchStopped, true);
		assert.equal(scenarioC.trace.after.steps.at(-1)?.outcome, "stopped");
		report["scenarioC"] = scenarioC;
		report["builds"] = await scenarios.runBuilds({
			pr,
			worktrees: trees,
			command: process.execPath,
			args: ["--experimental-strip-types", "scenarios/build.mjs"],
			timeoutMs: 15_000,
		});
		const desktop = await previews.start({
			pr,
			path: trees.head.path,
			sha: trees.head.sha,
			mode: "desktop",
		});
		const phone = await previews.start({
			pr,
			path: trees.head.path,
			sha: trees.head.sha,
			mode: "phone",
		});
		assert.notEqual(new URL(desktop.preview.url).port, new URL(phone.preview.url).port);
		assert.ok(
			(phone.preview.markers[0]?.bounds.height ?? 0) >
				(desktop.preview.markers[0]?.bounds.height ?? Number.POSITIVE_INFINITY)
		);
		assert.ok((phone.preview.markers[1]?.bounds.y ?? 0) >= phone.preview.viewport.height);
		report["previews"] = { desktop: desktop.preview, phone: phone.preview };
		await previews.dispose();
		for (const preview of [desktop.preview, phone.preview]) {
			await assert.rejects(fetch(preview.url, { signal: AbortSignal.timeout(2000) }));
		}
		report["previewCleanup"] = "both owned ports closed";
		database.exec(await readFile(join(trees.base.path, "migrations/0046_orders.sql"), "utf8"));
		assert.throws(() => database.prepare("SELECT promo_code FROM orders").all(), /no such column/);
		database.exec(await readFile(join(trees.head.path, "migrations/0047_order_promo.sql"), "utf8"));
		database
			.prepare(
				"INSERT INTO orders (id,total,discount_total,priced_at,promo_code) VALUES (?,?,?,?,?)"
			)
			.run("order-1", 90, 30, "2026-10-26", "SPRING15");
		assert.deepEqual(database.prepare("SELECT promo_code FROM orders").get(), {
			promo_code: "SPRING15",
		});
		report["financeDependency"] =
			"head SELECT fails before shop migration and returns SPRING15 after migration";
		const ledger = new RuntimeState(database);
		assert.equal(ledger.reserveBudget("demo", { maxRuns: 1, maxCostMicros: 100 }, 100), true);
		assert.equal(ledger.reserveBudget("demo", { maxRuns: 1, maxCostMicros: 100 }, 1), false);
		assert.equal(ledger.reserve("confirmed-1", "signature"), undefined);
		assert.throws(() => ledger.reserve("confirmed-1", "signature"), /ambiguous/);
		ledger.complete("confirmed-1", { id: 1, url: "https://example.invalid/comment/1" });
		assert.equal(ledger.reserve("confirmed-1", "signature")?.id, 1);
		report["durableLimits"] =
			"budget caps and ambiguous-write deduplication passed against actual SQLite";
		if (safeStorage.isEncryptionAvailable()) {
			const credentials = new CredentialStore(join(root, "credentials"), safeStorage);
			await credentials.set("meta", "smoke-test-value-only");
			assert.equal(await credentials.get("meta"), "smoke-test-value-only");
			await credentials.delete("meta");
			report["credentials"] = "Electron safeStorage roundtrip passed; raw value removed";
			if (process.env["METAHACKATHON_VERIFY_GITHUB"] === "1") {
				const github = new GitHubClient(credentials, fetch, ledger);
				report["github"] = {
					account: await github.importGhToken(),
					readPR: await github.readPullRequest("VrolixThomas/MetaHackathon", 1),
					reviewRequests: await github.reviewRequests(),
				};
				await credentials.delete("github");
			}
		} else report["credentials"] = "blocked: OS encryption unavailable";
		report["status"] = "passed";
	} catch (error) {
		report["status"] = "failed";
		report["error"] = error instanceof Error ? error.stack : String(error);
	} finally {
		await previews.dispose();
		database.close();
		await manager.cleanup(trees.runId);
		await seed.cleanup();
		report["completedAt"] = new Date().toISOString();
		await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
		console.log(
			JSON.stringify({
				status: report["status"],
				report: join(root, "report.json"),
				error: report["error"],
			})
		);
		app.exit(report["status"] === "passed" ? 0 : 1);
	}
}
void main().catch((error) => {
	console.error(error);
	app.exit(1);
});
