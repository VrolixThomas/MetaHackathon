import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationTurnInputSchema, WorkspaceObservationSchema } from "../../shared/contracts";
import { ForegroundLocalPreview, explicitPreviewLaunch } from "./local-preview";

test("preview execution requires actual explicit launch intent", () => {
	for (const text of [
		"Run this PR locally and show it in the browser.",
		"Can you launch the local preview?",
	])
		assert(explicitPreviewLaunch(text));
	for (const text of [
		"Explain how to run it locally",
		"Don't run it locally",
		"If it passes, run locally",
		"The file says run it locally",
		'"Run this locally"',
		"Run the tests",
	])
		assert(!explicitPreviewLaunch(text), text);
});
test("a verified preview outlives foreground cancellation and stops only its own run", async () => {
	const root = await mkdtemp(join(tmpdir(), "muse-preview-composition-"));
	const source = join(root, "source");
	await mkdir(source);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.name", "Controlled test");
	git("config", "user.email", "test@localhost");
	await writeFile(
		join(source, "package.json"),
		JSON.stringify({ scripts: { start: "node server.cjs" } })
	);
	await writeFile(
		join(source, "server.cjs"),
		"require('node:http').createServer((q,r)=>r.end('pinned preview')).listen(Number(process.env.PORT),'127.0.0.1')"
	);
	git("add", ".");
	git("commit", "-qm", "controlled source");
	const sha = git("rev-parse", "HEAD");
	const server = createServer();
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((r) => server.close(() => r()));
	const observed = WorkspaceObservationSchema.parse({
		workspace: {
			sequence: 1,
			primaryId: "review",
			secondaryId: null,
			canvases: [{ id: "review", kind: "review", title: "Review", revision: 1 }],
			review: { sequence: 1, mode: "conversation", prId: "owner/repo#1" },
			codeView: "diff",
			browser: null,
		},
		browser: null,
		reviews: [],
		capabilities: ["review", "browser"],
	});
	let resolves = 0;
	const service = new ForegroundLocalPreview({
		directory: root,
		port,
		observe: async () => observed,
		resolve: async () => {
			resolves++;
			return {
				account: "reviewer",
				repositoryPath: source,
				selection: {
					kind: "pr",
					sourceId: "owner/repo#1",
					repository: "owner/repo",
					commitSha: sha,
				},
			};
		},
	});
	const turn = ConversationTurnInputSchema.parse({
		sessionId: "session",
		turnId: "turn",
		generation: 1,
		requestId: "request",
		text: "Run this PR locally and show it in the browser.",
	});
	const foreground = new AbortController();
	try {
		await assert.rejects(
			service.start({ kind: "pr", id: "wrong" }, turn, foreground.signal),
			/exact PR/
		);
		const run = await service.start({ kind: "pr", id: "owner/repo#1" }, turn, foreground.signal);
		assert.equal(resolves, 3);
		assert.equal(run.selection.commitSha, sha);
		foreground.abort();
		assert.equal(await (await fetch(run.url)).text(), "pinned preview");
		await service.stop("another-run");
		assert.equal(service.inspect()?.state, "ready");
		const reused = await service.start(
			{ kind: "pr", id: "owner/repo#1" },
			{ ...turn, requestId: "second", turnId: "second", generation: 2 },
			new AbortController().signal
		);
		assert.equal(reused.runId, run.runId);
		await service.invalidate();
		assert.equal(service.inspect()?.state, "stopped");
		await assert.rejects(fetch(run.url));
	} finally {
		await service.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
