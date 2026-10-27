import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, describe, it } from "node:test";
import { VoiceSetupStatusSchema } from "../../shared/contracts";
import { VoiceDiagnosticError } from "../voice/diagnostics";
import type { SidecarOptions, VoiceBackend } from "../voice/sidecar";
import {
	type PreparedVoiceBackend,
	type VoiceCompositionOptions,
	createConfiguredVoiceRouter,
	createVoiceComposition,
} from "./voice";

const identity = { sessionId: "voice-session", turnId: "voice-turn", generation: 1 };

it("preserves the first canonical provider failure through composition and cleanup", async (t) => {
	const f = fixture(t);
	f.state.build = () => {
		const backend = new FakeSidecar();
		backend.handle = async (path) => {
			throw new VoiceDiagnosticError(
				path === "offer"
					? { stage: "meta", code: "auth", httpStatus: 401 }
					: { stage: "media", code: "failed" }
			);
		};
		return backend;
	};
	await ready(f.manager);
	await assert.rejects(f.manager.offer(offer), /Meta speech authentication failed/);
	await flush();
	assert.match((await f.manager.status()).error ?? "", /Meta speech authentication failed/);
});

it("uses the env voice ID and replaces the sidecar when that file selection changes", async (t) => {
	let voiceId = "env-first";
	const f = fixture(t, {
		getVoiceId: async () => voiceId,
		setVoiceId: async (value) => {
			voiceId = value;
		},
	});
	await ready(f.manager);
	assert.equal((await f.options[0]?.getCredentials())?.voiceId, "env-first");
	voiceId = "env-edited";
	assert.equal((await f.manager.status()).phase, "stopped");
	await ready(f.manager);
	assert.equal(f.sidecars.length, 2);
	await f.manager.configure({ voiceId: "env-final" });
	assert.equal(voiceId, "env-final");
	assert.equal(existsSync(join(f.directory, "voice/settings.json")), false);
});
const offer = { ...identity, type: "offer" as const, sdp: "test-offer", keywords: [] };
const answer = { type: "answer" as const, sdp: "test-answer" };
const secret = "upstream-secret-that-must-stay-in-main";
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeSidecar implements PreparedVoiceBackend {
	prepares = 0;
	disposals = 0;
	calls: { path: string; body: unknown; signal?: AbortSignal }[] = [];
	warmup: () => Promise<void> = async () => {};
	shutdown: () => Promise<void> = async () => {};
	handle: VoiceBackend["request"] = async (path) =>
		path === "offer" ? answer : path === "poll" ? { events: [] } : {};
	async prepare() {
		this.prepares++;
		await this.warmup();
	}
	async request(path: string, body: unknown, signal?: AbortSignal) {
		this.calls.push({ path, body, signal });
		return this.handle(path, body, signal);
	}
	async dispose() {
		this.disposals++;
		await this.shutdown();
	}
}

function fixture(t: TestContext, overrides: Partial<VoiceCompositionOptions> = {}) {
	const directory = mkdtempSync(join(tmpdir(), "met-8-voice-composition-"));
	const sidecars: FakeSidecar[] = [];
	const options: SidecarOptions[] = [];
	const state: {
		credentials: { meta?: string; elevenlabs?: string };
		available: boolean;
		build: () => FakeSidecar;
	} = {
		credentials: { meta: secret, elevenlabs: "eleven-secret" },
		available: true,
		build: () => new FakeSidecar(),
	};
	const manager = createVoiceComposition({
		getCredentials: async () => state.credentials,
		getDataDirectory: () => directory,
		command: "/trusted/voice-python",
		args: ["/trusted/sidecar.py"],
		executableAvailable: () => state.available,
		defaultVoiceId: "public-default-voice",
		createSidecar: (input) => {
			options.push(input);
			const backend = state.build();
			sidecars.push(backend);
			return backend;
		},
		...overrides,
	});
	t.after(async () => {
		await manager.dispose();
		rmSync(directory, { recursive: true, force: true });
	});
	return {
		manager,
		state,
		sidecars,
		options,
		directory,
		caller: createConfiguredVoiceRouter(manager).createCaller({}),
	};
}

async function ready(manager: ReturnType<typeof createVoiceComposition>) {
	await manager.prepare();
	for (let i = 0; i < 10; i++) {
		const status = await manager.status();
		if (status.phase === "ready") return;
		assert.equal(status.phase, "preparing");
		await flush();
	}
	assert.fail("injected local sidecar never became ready");
}

describe("MET-8 main voice composition setup", () => {
	it("registers a lazy manager getter without initializing main services", async (t) => {
		const { manager } = fixture(t);
		let calls = 0;
		const caller = createConfiguredVoiceRouter(() => {
			calls++;
			return manager;
		}).createCaller({});
		assert.equal(calls, 0);
		assert.equal((await caller.status()).phase, "stopped");
		assert.equal(calls, 1);
		const unavailable = createConfiguredVoiceRouter(() => {
			throw new Error(secret);
		}).createCaller({});
		await assert.rejects(
			unavailable.prepare(),
			(error: Error) => error.message === "Voice service is unavailable"
		);
	});
	it("reports missing prerequisites without constructing a sidecar or leaking keys", async (t) => {
		const { manager, state, sidecars } = fixture(t, { defaultVoiceId: undefined });
		state.credentials = {};
		state.available = false;
		const expected = {
			phase: "unconfigured",
			voiceId: null,
			missing: ["meta", "elevenlabs", "voiceId", "executable"],
		};
		assert.deepEqual(await manager.status(), expected);
		assert.deepEqual(await manager.prepare(), expected);
		await manager.cancel(identity);
		assert.equal(sidecars.length, 0);
	});
	it("persists only the public voice ID and prefers it to a root-supplied default", async (t) => {
		const { caller, directory, sidecars } = fixture(t);
		assert.equal((await caller.status()).voiceId, "public-default-voice");
		assert.deepEqual(await caller.configure({ voiceId: "  public-saved-voice  " }), {
			phase: "stopped",
			voiceId: "public-saved-voice",
			missing: [],
		});
		const saved = readFileSync(join(directory, "voice", "settings.json"), "utf8");
		assert.deepEqual(JSON.parse(saved), { voiceId: "public-saved-voice" });
		assert.equal(saved.includes(secret), false);
		assert.equal(sidecars.length, 0);
		const restarted = createVoiceComposition({
			getCredentials: async () => ({ meta: secret, elevenlabs: "eleven-secret" }),
			getDataDirectory: () => directory,
			command: "/trusted/voice",
			executableAvailable: () => true,
			defaultVoiceId: "different-default",
		});
		try {
			assert.deepEqual(await restarted.status(), {
				phase: "stopped",
				voiceId: "public-saved-voice",
				missing: [],
			});
		} finally {
			await restarted.dispose();
		}
	});
	it("returns preparing promptly, polls warmup, and starts only one local sidecar", async (t) => {
		const { caller, state, sidecars, options } = fixture(t);
		const boot = deferred<void>();
		state.build = () => {
			const backend = new FakeSidecar();
			backend.warmup = () => boot.promise;
			return backend;
		};
		const results = await Promise.all([caller.prepare(), caller.prepare(), caller.prepare()]);
		assert.deepEqual(
			results.map((value) => value.phase),
			["preparing", "preparing", "preparing"]
		);
		assert.equal((await caller.status()).phase, "preparing");
		assert.equal(sidecars.length, 1);
		assert.equal(sidecars[0]?.prepares, 1);
		assert.deepEqual(sidecars[0]?.calls, []);
		await assert.rejects(caller.offer(offer), /Voice request failed/);
		assert.equal(options[0]?.command, "/trusted/voice-python");
		assert.deepEqual(options[0]?.args, ["/trusted/sidecar.py"]);
		assert.deepEqual(await options[0]?.getCredentials(), {
			meta: secret,
			elevenlabs: "eleven-secret",
			voiceId: "public-default-voice",
		});
		boot.resolve();
		await flush();
		assert.equal((await caller.status()).phase, "ready");
		assert.equal(JSON.stringify(await caller.status()).includes(secret), false);
		assert.deepEqual(sidecars[0]?.calls, []);
	});
	it("keeps a healthy active turn when prepare is repeated", async (t) => {
		const { manager, caller, sidecars } = fixture(t);
		await ready(manager);
		assert.deepEqual(await caller.offer(offer), answer);
		assert.equal((await caller.prepare()).phase, "ready");
		await caller.release(identity);
		await caller.speak({ ...identity, speechId: "speech", text: "hello" });
		assert.deepEqual(await caller.poll({ ...identity, afterSequence: 0 }), { events: [] });
		assert.deepEqual(await caller.offer(offer), answer);
		assert.equal(sidecars.length, 1);
		assert.equal(sidecars[0]?.disposals, 0);
		assert.equal(sidecars[0]?.prepares, 1);
		assert.deepEqual(
			sidecars[0]?.calls.map(({ path }) => path),
			["offer", "release", "speak", "poll"]
		);
	});
	it("retries a failed local warmup using a disposed-and-replaced service", async (t) => {
		const { manager, state, sidecars } = fixture(t);
		state.build = () => {
			const backend = new FakeSidecar();
			backend.warmup = async () => {
				throw new Error(secret);
			};
			return backend;
		};
		await manager.prepare();
		await flush();
		const failed = await manager.status();
		assert.equal(failed.phase, "error");
		assert.equal(JSON.stringify(failed).includes(secret), false);
		state.build = () => {
			assert.equal(sidecars[0]?.disposals, 1);
			return new FakeSidecar();
		};
		await ready(manager);
		assert.equal(sidecars.length, 2);
	});
	it("retries backend failures but does not replace healthy service for a stale turn", async (t) => {
		const { manager, caller, sidecars } = fixture(t);
		await ready(manager);
		await assert.rejects(caller.release(identity), /Voice request failed/);
		assert.equal((await caller.prepare()).phase, "ready");
		assert.equal(sidecars.length, 1);
		const first = sidecars[0] as FakeSidecar;
		first.handle = async () => {
			throw new Error(secret);
		};
		await assert.rejects(
			caller.offer(offer),
			(error: Error) =>
				error.message.includes("Voice request failed") && !error.message.includes(secret)
		);
		assert.equal((await caller.status()).phase, "error");
		await ready(manager);
		assert.equal(first.disposals, 1);
		assert.equal(sidecars.length, 2);
		assert.deepEqual(await caller.offer({ ...offer, generation: 2 }), answer);
	});
	it("replaces an active service when credential values change and handles removal", async (t) => {
		const { manager, state, sidecars, options } = fixture(t);
		await ready(manager);
		await manager.offer(offer);
		state.credentials = { meta: "new-meta", elevenlabs: "new-eleven" };
		assert.equal((await manager.status()).phase, "stopped");
		await ready(manager);
		assert.equal(sidecars[0]?.disposals, 1);
		assert.equal(sidecars.length, 2);
		assert.deepEqual(await options[1]?.getCredentials(), {
			meta: "new-meta",
			elevenlabs: "new-eleven",
			voiceId: "public-default-voice",
		});
		state.credentials = { meta: "new-meta" };
		assert.deepEqual((await manager.prepare()).missing, ["elevenlabs"]);
		assert.equal(sidecars[1]?.disposals, 1);
		assert.equal(sidecars.length, 2);
	});
	it("sanitizes credential, executable and settings errors and permits repair", async (t) => {
		let fail = true;
		const { manager, directory } = fixture(t, {
			getCredentials: async () => {
				if (fail) throw new Error(secret);
				return { meta: secret, elevenlabs: "eleven-secret" };
			},
		});
		for (const result of [await manager.status(), await manager.prepare()]) {
			assert.equal(result.phase, "error");
			assert.equal(JSON.stringify(result).includes(secret), false);
			VoiceSetupStatusSchema.parse(result);
		}
		fail = false;
		await ready(manager);
		// A fresh manager encounters the corrupt persisted settings and can repair them via configure.
		mkdirSync(join(directory, "voice"), { recursive: true });
		writeFileSync(join(directory, "voice", "settings.json"), secret);
		const other = fixture(t, {
			getDataDirectory: () => directory,
			executableAvailable: () => {
				throw new Error(secret);
			},
		});
		assert.equal((await other.manager.status()).phase, "error");
		const result = await other.manager.configure({ voiceId: "repaired-public-voice" });
		assert.equal(result.phase, "error");
		assert.equal(JSON.stringify(result).includes(secret), false);
		assert.deepEqual(JSON.parse(readFileSync(join(directory, "voice", "settings.json"), "utf8")), {
			voiceId: "repaired-public-voice",
		});
	});
	it("sanitizes provider error events and validates protocol responses", async (t) => {
		const { manager, caller, sidecars } = fixture(t);
		await ready(manager);
		await caller.offer(offer);
		const backend = sidecars[0] as FakeSidecar;
		backend.handle = async () => ({
			events: [{ ...identity, kind: "error", sequence: 1, message: secret }],
		});
		const events = await caller.poll({ ...identity, afterSequence: 0 });
		assert.equal(events.events[0]?.kind, "error");
		assert.equal(JSON.stringify(events).includes(secret), false);
		assert.equal((await caller.status()).phase, "error");
		await ready(manager);
		const next = sidecars[1] as FakeSidecar;
		next.handle = async () => ({ sdp: secret, type: "invalid" });
		await assert.rejects(caller.offer({ ...offer, generation: 2 }), /Voice request failed/);
		assert.equal((await caller.status()).phase, "error");
	});
	it("rejects extra configuration fields and invalid protocol inputs at the router", async (t) => {
		const { caller, sidecars } = fixture(t);
		await assert.rejects(caller.configure({ voiceId: "" }));
		await assert.rejects(
			caller.configure({ voiceId: "public", meta: secret } as { voiceId: string })
		);
		await assert.rejects(caller.offer({ ...offer, generation: -1 }));
		assert.equal(sidecars.length, 0);
	});
});

describe("MET-8 voice cancellation and shutdown", () => {
	it("retains generation tombstones across reconfiguration and credential replacement", async (t) => {
		const { manager, state, sidecars } = fixture(t);
		await ready(manager);
		await manager.offer(offer);
		await manager.configure({ voiceId: "replacement" });
		await ready(manager);
		await assert.rejects(manager.offer(offer), /Voice request failed/);
		const next = { ...offer, generation: 2 };
		await manager.offer(next);
		await manager.cancel({ ...identity, generation: 2 });
		state.credentials = { ...state.credentials, meta: "changed-meta" };
		await ready(manager);
		await assert.rejects(manager.offer(next), /Voice request failed/);
		await manager.offer({ ...offer, generation: 3 });
		assert.equal(sidecars.length, 3);
	});
	it("idle cancellation starts nothing and tombstones the cancelled generation", async (t) => {
		const { manager, sidecars } = fixture(t);
		await manager.cancel(identity);
		assert.equal(sidecars.length, 0);
		await ready(manager);
		await assert.rejects(manager.offer(offer), /Voice request failed/);
		assert.deepEqual(await manager.offer({ ...offer, generation: 2 }), answer);
	});
	it("cancel aborts and drains an uncooperative offer including late cleanup", async (t) => {
		const { manager, sidecars } = fixture(t);
		await ready(manager);
		const backend = sidecars[0] as FakeSidecar;
		const response = deferred<unknown>();
		backend.handle = async (path) => (path === "offer" ? response.promise : {});
		const offered = manager.offer(offer);
		const rejected = assert.rejects(offered, /Voice request failed/);
		await flush();
		let drained = false;
		const cancelled = manager.cancel(identity).then(() => {
			drained = true;
		});
		await flush();
		assert.equal(backend.calls[0]?.signal?.aborted, true);
		assert.equal(drained, false);
		response.resolve(answer);
		await Promise.all([rejected, cancelled]);
		assert.equal(drained, true);
		assert.deepEqual(
			backend.calls.map(({ path }) => path),
			["offer", "cancel", "cancel"]
		);
		assert.equal((await manager.prepare()).phase, "ready");
		assert.equal(sidecars.length, 1);
	});
	it("a higher-generation cancel drains the previous turn but an old cancel preserves the new one", async (t) => {
		const { manager, sidecars } = fixture(t);
		await ready(manager);
		const backend = sidecars[0] as FakeSidecar;
		await manager.offer(offer);
		const response = deferred<unknown>();
		backend.handle = async (path) => (path === "poll" ? response.promise : answer);
		const polled = manager.poll({ ...identity, afterSequence: 0 });
		const rejected = assert.rejects(polled, /Voice request failed/);
		await flush();
		const next = { ...identity, turnId: "next", generation: 2 };
		let drained = false;
		const cancel = manager.cancel(next).then(() => {
			drained = true;
		});
		await flush();
		assert.equal(backend.calls.find(({ path }) => path === "poll")?.signal?.aborted, true);
		assert.equal(drained, false);
		response.resolve({ events: [] });
		await Promise.all([cancel, rejected]);
		const latest = { ...offer, generation: 3 };
		await manager.offer(latest);
		await manager.cancel(identity);
		await manager.speak({ ...identity, generation: 3, speechId: "still-active", text: "hello" });
	});
	it("configure aborts active service and waits for requests and child disposal before replacing it", async (t) => {
		const { manager, sidecars, directory } = fixture(t);
		await ready(manager);
		await manager.offer(offer);
		const backend = sidecars[0] as FakeSidecar;
		const response = deferred<unknown>();
		const stopped = deferred<void>();
		backend.handle = async () => response.promise;
		backend.shutdown = () => stopped.promise;
		const speech = manager.speak({ ...identity, speechId: "speaking", text: "hi" });
		const rejected = assert.rejects(speech, /Voice request failed/);
		await flush();
		let configured = false;
		const configuration = manager.configure({ voiceId: "replacement" }).then((status) => {
			configured = true;
			return status;
		});
		await flush();
		assert.equal(backend.disposals, 1);
		assert.equal(backend.calls.at(-1)?.signal?.aborted, true);
		assert.equal(configured, false);
		stopped.resolve();
		await flush();
		assert.equal(configured, false);
		response.resolve({});
		assert.equal((await configuration).phase, "stopped");
		await rejected;
		assert.equal(
			JSON.parse(readFileSync(join(directory, "voice", "settings.json"), "utf8")).voiceId,
			"replacement"
		);
		await ready(manager);
		assert.equal(sidecars.length, 2);
	});
	it("reconfiguration waits for stale warmup without allowing it to resurrect the service", async (t) => {
		const { manager, state, sidecars } = fixture(t);
		const boot = deferred<void>();
		state.build = () => {
			const backend = new FakeSidecar();
			backend.warmup = () => boot.promise;
			return backend;
		};
		await manager.prepare();
		let configured = false;
		const configuration = manager.configure({ voiceId: "replacement" }).then((status) => {
			configured = true;
			return status;
		});
		await flush();
		assert.equal(sidecars[0]?.disposals, 1);
		assert.equal(configured, false);
		await assert.rejects(manager.offer(offer));
		boot.resolve();
		assert.equal((await configuration).phase, "stopped");
		assert.equal((await manager.status()).phase, "stopped");
		state.build = () => new FakeSidecar();
		await ready(manager);
		assert.equal(sidecars.length, 2);
	});
	it("shutdown drains warmup, is idempotent, and prevents late startup or any reuse", async (t) => {
		const { manager, state, sidecars } = fixture(t);
		const boot = deferred<void>();
		state.build = () => {
			const backend = new FakeSidecar();
			backend.warmup = () => boot.promise;
			return backend;
		};
		await manager.prepare();
		const disposal = manager.dispose();
		assert.equal(manager.dispose(), disposal);
		let drained = false;
		void disposal.then(() => {
			drained = true;
		});
		await flush();
		assert.equal(sidecars[0]?.disposals, 1);
		assert.equal(drained, false);
		boot.resolve();
		await disposal;
		assert.equal(drained, true);
		await assert.rejects(manager.prepare(), /shut down/);
		await assert.rejects(manager.status(), /shut down/);
		await assert.rejects(manager.configure({ voiceId: "late" }), /shut down/);
		await assert.rejects(manager.offer(offer), /Voice request failed/);
		await assert.rejects(manager.cancel(identity), /Voice request failed/);
		assert.equal(sidecars.length, 1);
	});
	it("shutdown during credential lookup waits for the lookup and never creates a sidecar", async (t) => {
		const credentials = deferred<{ meta: string; elevenlabs: string }>();
		const { manager, sidecars } = fixture(t, { getCredentials: () => credentials.promise });
		const preparation = manager.prepare();
		const rejected = assert.rejects(preparation, /shut down/);
		await flush();
		let drained = false;
		const disposal = manager.dispose().then(() => {
			drained = true;
		});
		await flush();
		assert.equal(drained, false);
		credentials.resolve({ meta: secret, elevenlabs: "eleven-secret" });
		await Promise.all([disposal, rejected]);
		assert.equal(sidecars.length, 0);
	});
	it("shutdown aborts and drains uncooperative media before completing", async (t) => {
		const { manager, sidecars } = fixture(t);
		await ready(manager);
		await manager.offer(offer);
		const backend = sidecars[0] as FakeSidecar;
		const response = deferred<unknown>();
		backend.handle = async () => response.promise;
		const polled = manager.poll({ ...identity, afterSequence: 0 });
		const rejected = assert.rejects(polled, /Voice request failed/);
		await flush();
		let drained = false;
		const disposal = manager.dispose().then(() => {
			drained = true;
		});
		await flush();
		assert.equal(backend.calls.at(-1)?.signal?.aborted, true);
		assert.equal(drained, false);
		response.resolve({ events: [] });
		await Promise.all([disposal, rejected]);
		assert.equal(backend.disposals, 1);
	});
	it("shutdown denies a queued cached offer result", async (t) => {
		const { manager, sidecars } = fixture(t);
		await ready(manager);
		await manager.offer(offer);
		const cached = manager.offer(offer);
		const rejected = assert.rejects(cached, /Voice request failed/);
		await manager.dispose();
		await rejected;
		assert.equal(sidecars[0]?.disposals, 1);
	});
});
