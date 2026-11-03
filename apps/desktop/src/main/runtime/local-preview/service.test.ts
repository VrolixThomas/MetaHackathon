import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalPreviewService } from "./service";

const npm = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "local-preview-test-"));
	const source = join(root, "source");
	await mkdir(source);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.email", "test@localhost");
	git("config", "user.name", "Test");
	await writeFile(
		join(source, "package.json"),
		JSON.stringify({
			scripts: { start: "node server.cjs", prestart: "exit 89", poststart: "exit 90" },
		})
	);
	await writeFile(
		join(source, "server.cjs"),
		`const http=require('node:http');http.createServer((q,r)=>r.end(JSON.stringify({revision:'pinned',secret:process.env["MODEL_API_KEY"]||null,home:process.env.HOME}))).listen(Number(process.env.PORT),'127.0.0.1');`
	);
	git("add", ".");
	git("commit", "-qm", "fixture");
	const sha = git("rev-parse", "HEAD");
	await writeFile(join(source, "server.cjs"), "uncommitted user work");
	const server = createServer();
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((r) => server.close(() => r()));
	const request = {
		authorityId: "actual-ingress-receipt",
		selection: { kind: "pr" as const, sourceId: "pr-1", repository: "owner/repo", commitSha: sha },
	};
	return { root, source, port, request, git };
}
test("runs pinned committed npm start, strips secrets, preserves dirty source and stops listener", async () => {
	const f = await fixture();
	const before = f.git("status", "--porcelain");
	let auth = 0;
	const service = new LocalPreviewService({
		directory: join(f.root, "owned"),
		npmExecutable: npm,
		port: f.port,
		authorize: async (request) => {
			assert.deepEqual(request, f.request);
			auth++;
			return { repositoryPath: f.source };
		},
	});
	const old = process.env["MODEL_API_KEY"];
	process.env["MODEL_API_KEY"] = "must-not-reach-child";
	try {
		const receipt = await service.start(f.request);
		assert.equal(auth, 1);
		assert.equal(receipt.selection.commitSha, f.request.selection.commitSha);
		const response = (await (await fetch(receipt.url)).json()) as {
			revision: string;
			secret: null;
			home: string;
		};
		assert.equal(response.revision, "pinned");
		assert.equal(response.secret, null);
		assert.ok(response.home.startsWith(await realpath(join(f.root, "owned"))));
		assert.equal(f.git("status", "--porcelain"), before);
		assert.equal(await readFile(join(f.source, "server.cjs"), "utf8"), "uncommitted user work");
		await assert.rejects(service.start(f.request), /already running/);
		await service.stop();
		await assert.rejects(fetch(receipt.url));
		const log = JSON.parse(await readFile(receipt.logPath, "utf8"));
		assert.equal(log.state, "stopped");
		assert.ok(log.endedAt);
	} finally {
		if (old === undefined) Reflect.deleteProperty(process.env, "MODEL_API_KEY");
		else process.env["MODEL_API_KEY"] = old;
		await service.dispose();
		await rm(f.root, { recursive: true, force: true });
	}
});
test("rejects missing authority and unavailable SHA before executing repository code", async () => {
	const f = await fixture();
	const denied = new LocalPreviewService({
		directory: join(f.root, "denied"),
		npmExecutable: npm,
		port: f.port,
		authorize: async () => {
			throw Error("No explicit user consent");
		},
	});
	const service = new LocalPreviewService({
		directory: join(f.root, "owned"),
		npmExecutable: npm,
		port: f.port,
		authorize: async () => ({ repositoryPath: f.source }),
	});
	try {
		await assert.rejects(denied.start(f.request), /consent/);
		await assert.rejects(
			service.start({
				...f.request,
				selection: { ...f.request.selection, commitSha: "a".repeat(40) },
			}),
			/Git preparation/
		);
	} finally {
		await denied.dispose();
		await service.dispose();
		await rm(f.root, { recursive: true, force: true });
	}
});
test("abort during authorization never launches and shutdown rejects new work", async () => {
	const f = await fixture();
	const controller = new AbortController();
	const service = new LocalPreviewService({
		directory: join(f.root, "owned"),
		npmExecutable: npm,
		port: f.port,
		authorize: async () => {
			controller.abort();
			return { repositoryPath: f.source };
		},
	});
	try {
		await assert.rejects(service.start(f.request, controller.signal));
		await service.dispose();
		await assert.rejects(service.start(f.request), /unavailable/);
	} finally {
		await service.dispose();
		await rm(f.root, { recursive: true, force: true });
	}
});
test("occupied port is not accepted as execution readiness", async () => {
	const f = await fixture();
	const server = createServer();
	await new Promise<void>((r) => server.listen(f.port, "127.0.0.1", r));
	const service = new LocalPreviewService({
		directory: join(f.root, "owned"),
		npmExecutable: npm,
		port: f.port,
		authorize: async () => ({ repositoryPath: f.source }),
	});
	try {
		await assert.rejects(service.start(f.request), /occupied/);
	} finally {
		await service.dispose();
		await new Promise<void>((r) => server.close(() => r()));
		await rm(f.root, { recursive: true, force: true });
	}
});

test("abort after readiness drains owned process and persists terminal log", async () => {
	const f = await fixture();
	const controller = new AbortController();
	const service = new LocalPreviewService({
		directory: join(f.root, "owned"),
		npmExecutable: npm,
		port: f.port,
		authorize: async () => ({ repositoryPath: f.source }),
	});
	try {
		const receipt = await service.start(f.request, controller.signal);
		controller.abort();
		await service.stop();
		await assert.rejects(fetch(receipt.url));
		const log = JSON.parse(await readFile(receipt.logPath, "utf8"));
		assert.equal(log.state, "stopped");
		assert.ok(log.endedAt);
	} finally {
		await service.dispose();
		await rm(f.root, { recursive: true, force: true });
	}
});

test("readiness timeout kills child and retains failure log", async () => {
	const f = await fixture();
	await writeFile(join(f.source, "server.cjs"), "setInterval(()=>{},1000)");
	f.git("add", ".");
	f.git("commit", "-qm", "no listener");
	f.request.selection.commitSha = f.git("rev-parse", "HEAD");
	const service = new LocalPreviewService({
		directory: join(f.root, "owned"),
		npmExecutable: npm,
		port: f.port,
		timeoutMs: 200,
		authorize: async () => ({ repositoryPath: f.source }),
	});
	try {
		await assert.rejects(service.start(f.request), /timed out/);
	} finally {
		await service.dispose();
		await rm(f.root, { recursive: true, force: true });
	}
});
