import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LEGACY_CODING_MODEL, NEW_CODING_MODEL } from "../../agent/coding-model";
import type { CodingTaskInput } from "../../agent/coding-worker";
import {
	type CodingProviderPorts,
	codingProviderFailureCode,
	runPinnedCodingTask,
	stripCodingProviderEnvironment,
} from "./dispatch";

test("actual dispatch seam pins before fake model work and forwards CLI coordinator context unchanged", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-provider-dispatch-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "worktree"));
	const input: CodingTaskInput = {
		jobId: "job",
		ticket: null,
		repository: "owner/repo",
		worktreePath: join(root, "worktree"),
		checkpointPath: join(root, "private", "checkpoint.json"),
		brief: "Controlled task",
		decisionContext: "Exact trusted decision",
		validationFeedback: "Exact failed check",
	};
	const calls: string[] = [];
	const signal = new AbortController().signal;
	const ports: CodingProviderPorts = {
		log: async (value) => {
			calls.push(value);
		},
		meta: async () => {
			calls.push("WRONG META FALLBACK");
			throw new Error("Wrong provider");
		},
		muse: async (received, options, receivedSignal) => {
			assert.deepEqual(received, input);
			assert.equal(receivedSignal, signal);
			assert.deepEqual(options, { musePath: "/controlled/muse" });
			const files = await readdir(join(root, "private"));
			assert.equal(files.length, 1, "Pin must be durable before adapter invocation");
			assert.equal(
				JSON.parse(await readFile(join(root, "private", files[0] ?? ""), "utf8")).settings.provider,
				"muse-code"
			);
			calls.push("muse");
			return {
				status: "needs-input",
				summary: "No checks fabricated",
				question: "Log in to the selected coding provider?",
			};
		},
	};
	const result = await runPinnedCodingTask(
		input,
		async () => ({ provider: "muse-code", musePath: "/controlled/muse" }),
		ports,
		signal
	);
	assert.equal(result.status, "needs-input");
	assert.deepEqual(calls, ["[coding-provider] Selected muse-code", "muse"]);
	ports.muse = async () => {
		throw new Error("Controlled quota/auth/unsupported failure");
	};
	await assert.rejects(
		runPinnedCodingTask(
			input,
			async () => ({ provider: "meta-api", musePath: null }),
			ports,
			signal
		),
		/quota\/auth/
	);
	assert.ok(!calls.includes("WRONG META FALLBACK"));
});

test("abort after durable selection/logging starts neither provider and settings affect only new jobs", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-provider-abort-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "worktree"));
	const input: CodingTaskInput = {
		jobId: "job",
		ticket: null,
		repository: "owner/repo",
		worktreePath: join(root, "worktree"),
		checkpointPath: join(root, "private", "checkpoint.json"),
		brief: "Controlled",
	};
	const abort = new AbortController();
	let calls = 0;
	const ports: CodingProviderPorts = {
		log: async () => abort.abort(),
		meta: async () => {
			calls++;
			return { status: "completed", summary: "Controlled only" };
		},
		muse: async () => {
			calls++;
			return { status: "completed", summary: "Controlled only" };
		},
	};
	await assert.rejects(
		runPinnedCodingTask(
			input,
			async () => ({ provider: "meta-api", musePath: null }),
			ports,
			abort.signal
		),
		{ name: "AbortError" }
	);
	assert.equal(calls, 0);
	ports.log = async () => {};
	ports.muse = async () => {
		throw new Error("Cannot switch an existing Meta job");
	};
	await runPinnedCodingTask(
		input,
		async () => ({ provider: "muse-code", musePath: "/changed" }),
		ports,
		new AbortController().signal
	);
	assert.equal(calls, 1);
});

test("provider keys cannot be inherited by the CLI; ordinary execution environment remains", () => {
	const environment = {
		PATH: "/bin",
		HOME: "/controlled/home",
		LANG: "en_US.UTF-8",
		MODEL_API_KEY: "model-secret",
		META_API_KEY: "meta-secret",
		OPENAI_API_KEY: "other-secret",
		GITHUB_TOKEN: "gh-secret",
		LINEAR_API_KEY: "linear-secret",
		SLACK_USER_TOKEN: "slack-secret",
		MUSE_CODE_API_KEY: "billing-override",
		PRIVATE_KEY: "key",
		MUSE_CODE_PATH: "/controlled/muse",
	};
	stripCodingProviderEnvironment(environment);
	assert.deepEqual(environment, {
		PATH: "/bin",
		HOME: "/controlled/home",
		LANG: "en_US.UTF-8",
		MUSE_CODE_PATH: "/controlled/muse",
	});
	assert.equal(
		codingProviderFailureCode({ code: "quota-exceeded", message: "SECRET provider frame" }),
		"quota-exceeded"
	);
	assert.equal(codingProviderFailureCode({ code: "SECRET account details" }), null);
	assert.equal(codingProviderFailureCode(new Error("SECRET prompt")), null);
});

test("provider pin changes during logging cannot enter either model branch", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-provider-race-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "worktree"));
	const input: CodingTaskInput = {
		jobId: "job",
		ticket: null,
		repository: "owner/repo",
		worktreePath: join(root, "worktree"),
		checkpointPath: join(root, "private", "checkpoint.json"),
		brief: "Controlled",
	};
	let calls = 0;
	const ports: CodingProviderPorts = {
		log: async () => {
			const name = (await readdir(join(root, "private")))[0] ?? "";
			const path = join(root, "private", name);
			const pin = JSON.parse(await readFile(path, "utf8"));
			pin.settings = { provider: "muse-code", musePath: null };
			Reflect.deleteProperty(pin, "codingModel");
			await writeFile(path, JSON.stringify(pin));
		},
		meta: async () => {
			calls++;
			return { status: "completed", summary: "Must not run" };
		},
		muse: async () => {
			calls++;
			return { status: "completed", summary: "Must not run" };
		},
	};
	await assert.rejects(
		runPinnedCodingTask(
			input,
			async () => ({ provider: "meta-api", musePath: null }),
			ports,
			new AbortController().signal
		),
		/changed before dispatch/
	);
	assert.equal(calls, 0);
});

for (const codingModel of [undefined, NEW_CODING_MODEL]) {
	test(`Meta dispatch keeps ${codingModel ? "new" : "legacy"} selection through reopen without fallback`, async (t) => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "coding-model-dispatch-")));
		t.after(() => rm(root, { recursive: true, force: true }));
		await mkdir(join(root, "worktree"));
		const input: CodingTaskInput = {
			jobId: "job",
			ticket: null,
			repository: "owner/repo",
			worktreePath: join(root, "worktree"),
			checkpointPath: join(root, "private", "checkpoint.json"),
			brief: "Controlled",
			...(codingModel ? { codingModel } : {}),
		};
		const expected = codingModel ?? LEGACY_CODING_MODEL;
		const received: CodingTaskInput[] = [];
		const ports: CodingProviderPorts = {
			log: async () => {},
			muse: async () => {
				throw Error("No CLI fallback");
			},
			meta: async (task) => {
				received.push(task);
				assert.deepEqual(task.codingModel, expected);
				return { status: "needs-input", summary: "Question", question: "Which behavior?" };
			},
		};
		await runPinnedCodingTask(
			input,
			async () => ({ provider: "meta-api", musePath: null }),
			ports,
			new AbortController().signal
		);
		const { codingModel: _model, ...legacyIngress } = input;
		await runPinnedCodingTask(
			{ ...legacyIngress, decisionContext: "Keep behavior" },
			async () => {
				throw Error("Must not reread settings");
			},
			ports,
			new AbortController().signal
		);
		assert.equal(received.length, 2);
		assert.equal(received[1]?.decisionContext, "Keep behavior");
		assert.deepEqual(
			{ ...received[0], codingModel: undefined },
			{ ...input, codingModel: undefined },
			"source and task identity remain exact"
		);
	});
}

test("model pin mutation during dispatch is rejected before either provider starts", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-model-race-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "worktree"));
	const input: CodingTaskInput = {
		jobId: "job",
		ticket: null,
		repository: "owner/repo",
		worktreePath: join(root, "worktree"),
		checkpointPath: join(root, "private", "checkpoint.json"),
		brief: "Controlled",
		codingModel: NEW_CODING_MODEL,
	};
	let calls = 0;
	const ports: CodingProviderPorts = {
		log: async () => {
			const path = join(root, "private", (await readdir(join(root, "private")))[0] ?? "");
			const pin = JSON.parse(await readFile(path, "utf8"));
			await writeFile(path, JSON.stringify({ ...pin, codingModel: LEGACY_CODING_MODEL }));
		},
		meta: async () => {
			calls++;
			throw Error("Must not call");
		},
		muse: async () => {
			calls++;
			throw Error("Must not call");
		},
	};
	await assert.rejects(
		runPinnedCodingTask(
			input,
			async () => ({ provider: "meta-api", musePath: null }),
			ports,
			new AbortController().signal
		),
		/identity changed/
	);
	assert.equal(calls, 0);
});
