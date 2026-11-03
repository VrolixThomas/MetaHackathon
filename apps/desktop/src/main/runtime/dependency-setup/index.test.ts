import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setupDependencies } from "./index";

async function fixture(
	manager: "bun" | "npm",
	work: (f: {
		tree: string;
		root: string;
		run: (signal?: AbortSignal) => Promise<string>;
		executable: string;
		baseline: Record<string, string>;
	}) => Promise<void>
) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "dependency-setup-")));
	const tree = join(root, "tree");
	const bin = join(root, "bin");
	const directory = join(root, "private");
	for (const path of [tree, bin, directory]) await mkdir(path);
	const baseline: Record<string, string> = {};
	for (const [path, text] of Object.entries({
		"package.json": JSON.stringify({
			packageManager: `${manager}@1.2.3`,
			scripts: { postinstall: "baseline lifecycle" },
		}),
		[manager === "bun" ? "bun.lock" : "package-lock.json"]: "controlled lock\n",
	})) {
		await writeFile(join(tree, path), text);
		baseline[path] = createHash("sha1")
			.update(`blob ${Buffer.byteLength(text)}\0${text}`)
			.digest("hex");
	}
	const executable = join(bin, manager);
	await writeFile(
		executable,
		`#!/bin/sh\nif [ "$1" = --version ]; then echo 1.2.3; exit 0; fi\nprintf '%s\\n' "$*" >> calls\nprintf '%s\\n' "$HOME|$MODEL_API_KEY|$NODE_OPTIONS|$npm_config_userconfig" > environment\nmkdir -p node_modules\necho lifecycle-complete > node_modules/proof\n`,
		{ mode: 0o700 }
	);
	const oldPath = process.env["PATH"];
	const oldKey = process.env["MODEL_API_KEY"];
	process.env["PATH"] = `${bin}:${oldPath}`;
	process.env["MODEL_API_KEY"] = "must-not-inherit";
	try {
		await work({
			tree,
			root,
			executable,
			baseline,
			run: (signal = new AbortController().signal) =>
				setupDependencies({ tree, directory, baseline, signal, verify: async () => {} }),
		});
	} finally {
		process.env["PATH"] = oldPath;
		if (oldKey === undefined) Reflect.deleteProperty(process.env, "MODEL_API_KEY");
		else process.env["MODEL_API_KEY"] = oldKey;
		await rm(root, { recursive: true, force: true });
	}
}
for (const manager of ["bun", "npm"] as const)
	test(`${manager}: fixed frozen argv, private environment, repeat setup and receipt`, async () => {
		await fixture(manager, async ({ tree, root, run }) => {
			await run();
			await run();
			const expected = manager === "bun" ? "install --frozen-lockfile" : "ci --no-audit --no-fund";
			assert.equal(await readFile(join(tree, "calls"), "utf8"), `${expected}\n${expected}\n`);
			assert.equal(
				await readFile(join(tree, "environment"), "utf8"),
				`${root}/private/dependency-home|||/dev/null\n`
			);
			const receipt = JSON.parse(
				await readFile(join(root, "private/dependency-setup.json"), "utf8")
			);
			assert.equal(receipt.exitCode, 0);
			assert.equal(receipt.lifecycle, "baseline-default");
		});
	});
for (const file of ["package.json", "bun.lock"])
	test(`rejects ${file} drift before execution`, async () => {
		await fixture("bun", async ({ tree, run }) => {
			await writeFile(join(tree, file), "changed");
			await assert.rejects(run(), /baseline drift/);
			await assert.rejects(readFile(join(tree, "calls")), /ENOENT/);
		});
	});
test("rejects added nested metadata, symlink escapes and cancellation", async () => {
	await fixture("bun", async ({ tree, root, run }) => {
		await mkdir(join(tree, "nested"));
		await writeFile(join(tree, "nested/package.json"), "{}");
		await assert.rejects(run(), /metadata differs/);
		await rm(join(tree, "nested"), { recursive: true });
		await symlink(root, join(tree, "node_modules"));
		await assert.rejects(run(), /Unsafe dependency directory/);
		await rm(join(tree, "node_modules"));
		await assert.rejects(run(AbortSignal.abort()), /cancelled/);
	});
});
test("failed and interrupted installs retain actual receipts; successful install cannot change metadata", async () => {
	await fixture("bun", async ({ tree, root, executable, run }) => {
		const script = (body: string) =>
			writeFile(
				executable,
				`#!/bin/sh\nif [ "$1" = --version ]; then echo 1.2.3; exit 0; fi\n${body}\n`,
				{ mode: 0o700 }
			);
		await script("echo actual-failure >&2; exit 7");
		await assert.rejects(run(), /exited 7/);
		let receipt = JSON.parse(await readFile(join(root, "private/dependency-setup.json"), "utf8"));
		assert.equal(receipt.exitCode, 7);
		assert.match(receipt.output, /actual-failure/);
		await script("echo started > installing; sleep 30");
		const controller = new AbortController();
		const interrupted = assert.rejects(run(controller.signal), /130|cancelled/);
		try {
			for (let attempt = 0; attempt < 200; attempt++) {
				if (await readFile(join(tree, "installing")).catch(() => null)) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(await readFile(join(tree, "installing"), "utf8"), "started\n");
		} finally {
			controller.abort();
			await interrupted;
		}
		receipt = JSON.parse(await readFile(join(root, "private/dependency-setup.json"), "utf8"));
		assert.equal(receipt.exitCode, 130);
		await script("echo changed > bun.lock");
		await assert.rejects(run(), /baseline drift/);
		assert.equal(await readFile(join(tree, "bun.lock"), "utf8"), "changed\n");
	});
});

test("unsupported manager and unavailable pinned version fail before installing", async () => {
	await fixture("bun", async ({ tree, executable, baseline, run }) => {
		await writeFile(executable, "#!/bin/sh\necho 9.9.9\n", { mode: 0o700 });
		await assert.rejects(run(), /baseline package manager version/);
		const text = JSON.stringify({ packageManager: "pnpm@9.1.0" });
		await writeFile(join(tree, "package.json"), text);
		baseline["package.json"] = createHash("sha1")
			.update(`blob ${Buffer.byteLength(text)}\0${text}`)
			.digest("hex");
		await assert.rejects(run(), /Unsupported packageManager/);
	});
});

test("dependency-free standalone projects need no lockfile or package manager invocation", async () => {
	await fixture("npm", async ({ tree, root, baseline, run }) => {
		await rm(join(tree, "package-lock.json"));
		Reflect.deleteProperty(baseline, "package-lock.json");
		const text = JSON.stringify({ scripts: { test: "node --test" } });
		await writeFile(join(tree, "package.json"), text);
		baseline["package.json"] = createHash("sha1")
			.update(`blob ${Buffer.byteLength(text)}\0${text}`)
			.digest("hex");
		assert.match(await run(), /No declared dependencies/);
		await assert.rejects(readFile(join(tree, "calls")), /ENOENT/);
		assert.equal(
			JSON.parse(await readFile(join(root, "private/dependency-setup.json"), "utf8")).command,
			null
		);
		const dependencyText = JSON.stringify({ dependencies: { zod: "4.0.0" } });
		await writeFile(join(tree, "package.json"), dependencyText);
		baseline["package.json"] = createHash("sha1")
			.update(`blob ${Buffer.byteLength(dependencyText)}\0${dependencyText}`)
			.digest("hex");
		await assert.rejects(run(), /frozen lockfile/);
	});
});
