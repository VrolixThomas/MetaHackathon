import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { PullRequest } from "../../shared/contracts";
import { seedDemoRepositories } from "./demo";
import { RepositoryManager } from "./repositories";
import { ScenarioRunner } from "./scenarios";

test("executes A–D on real base/head Git worktrees; preserves the deliberate regression", async () => {
	const root = await mkdtemp(join(tmpdir(), "runtime-scenarios-"));
	const seed = await seedDemoRepositories(root, resolve("fixtures/demo"));
	const manager = new RepositoryManager(join(root, "worktrees"));
	const trees = await manager.prepare({
		repositoryPath: seed.shop.path,
		baseRef: seed.shop.baseSha,
		headRef: seed.shop.headSha,
	});
	const pr: PullRequest = {
		id: "shop-web#1284",
		repository: "shop-web",
		number: 1284,
		url: "https://example.invalid/shop/pull/1284",
		author: "Noor",
		title: "SHOP-482",
		baseSha: seed.shop.baseSha,
		headSha: seed.shop.headSha,
	};
	const runner = new ScenarioRunner(join(root, "logs"));
	try {
		const a = await runner.runScenario({
			pr,
			worktrees: trees,
			scenarioId: "A",
			title: "Stack 10 + 15",
			timeoutMs: 10_000,
		});
		assert.deepEqual(a.results, { base: { total: 102 }, head: { total: 90 } });
		const b = await runner.runScenario({
			pr,
			worktrees: trees,
			scenarioId: "B",
			title: "Cap 20 + 30",
			timeoutMs: 10_000,
		});
		assert.deepEqual(b.results, { base: { total: 84 }, head: { total: 72 } });
		const c = await runner.runScenario({
			pr,
			worktrees: trees,
			scenarioId: "C",
			title: "Expired code in nightly reminder",
			timeoutMs: 10_000,
		});
		assert.deepEqual(c.results.base, {
			sent: [
				{ cartId: "abandoned-1", total: 108 },
				{ cartId: "abandoned-2", total: 72 },
			],
			batchStopped: false,
		});
		assert.deepEqual(c.results.head, {
			error: "PromoExpiredError",
			message: "Promo code SPRING15 has expired",
			sent: [],
			batchStopped: true,
		});
		assert.equal(c.trace.divergenceIndex, 3);
		assert.equal(c.trace.after.steps[3]?.outcome, "throw");
		const throwingStep = c.trace.after.steps[3];
		assert.ok(throwingStep);
		const throwingSource = (
			await readFile(join(trees.head.path, throwingStep.location.path), "utf8")
		).split("\n");
		assert.match(
			throwingSource[throwingStep.location.startLine - 1] ?? "",
			/^\s*throw new PromoExpiredError/
		);
		const callerStep = c.trace.after.steps[0];
		assert.ok(callerStep);
		const callerSource = (
			await readFile(join(trees.head.path, callerStep.location.path), "utf8")
		).split("\n");
		assert.match(
			callerSource[callerStep.location.startLine - 1] ?? "",
			/^\s*const total = applyDiscounts/
		);
		assert.equal(c.trace.before.evidence.kind, "execution");
		assert.equal(c.trace.after.evidence.kind, "execution");
		for (const run of [c.trace.before, c.trace.after])
			for (const step of run.steps) {
				const source = await readFile(join(trees[run.revision].path, step.location.path), "utf8");
				assert.ok(source.split("\n")[step.location.startLine - 1]);
				assert.equal(step.location.commitSha, trees[run.revision].sha);
			}
		const d = await runner.runScenario({
			pr,
			worktrees: trees,
			scenarioId: "D",
			title: "Tier drops",
			timeoutMs: 10_000,
		});
		assert.deepEqual(d.results, {
			base: { quoted: 102, paid: 102 },
			head: { quoted: 90, paid: 102 },
		});
		const builds = await runner.runBuilds({
			pr,
			worktrees: trees,
			command: process.execPath,
			args: ["--experimental-strip-types", "scenarios/build.mjs"],
			timeoutMs: 10_000,
		});
		assert.equal(builds.base.exitCode, 0);
		assert.equal(builds.head.exitCode, 0);
		const generated = await runner.runGeneratedTest({
			pr,
			worktrees: trees,
			filename: "timeout.mjs",
			title: "Timeout",
			source: "setInterval(() => {}, 1000)",
			timeoutMs: 150,
		});
		assert.equal(generated.trace.before.status, "timed-out");
		assert.equal(generated.trace.after.status, "timed-out");
		await writeFile(join(trees.head.path, "pricing/price.ts"), "throw Error('modified');");
		await assert.rejects(
			runner.runScenario({
				pr,
				worktrees: trees,
				scenarioId: "A",
				title: "Dirty",
				timeoutMs: 1000,
			}),
			/tracked changes/
		);
		// Restore only the exact file this test changed, using its committed fixture bytes.
		await writeFile(
			join(trees.head.path, "pricing/price.ts"),
			await readFile(resolve("fixtures/demo/shop-web/base/pricing/price.ts"))
		);
	} finally {
		await manager.cleanup(trees.runId);
		await seed.cleanup();
		await rm(root, { recursive: true });
	}
});
