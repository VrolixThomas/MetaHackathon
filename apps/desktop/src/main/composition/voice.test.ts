import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, describe, it } from "node:test";
import {
	type TurnIdentity,
	type VoiceDiagnostic,
	VoiceSetupStatusSchema,
} from "../../shared/contracts";
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

const next = (generation = 2): TurnIdentity => ({
	...identity,
	turnId: `next-${generation}`,
	generation,
});
const errorEvent = (diagnostic?: VoiceDiagnostic, turn = identity, sequence = 1) => ({
	...turn,
	kind: "error" as const,
	sequence,
	message: secret,
	...(diagnostic ? { diagnostic } : {}),
});

describe("MET-51 provisional voice admission", () => {
	it("registers before a held offer, deduplicates it and requires a matching activation before capture", async (t) => {
		const { manager, caller, sidecars } = fixture(t);
		await ready(manager);
		const backend = sidecars[0] as FakeSidecar;
		const response = deferred<unknown>();
		backend.handle = async (path) => (path === "offer" ? response.promise : {});
		const first = caller.offerPrepared(offer);
		const duplicate = caller.offerPrepared(offer);
		await flush();
		assert.equal(backend.calls.filter(({ path }) => path === "offer").length, 1);
		await assert.rejects(caller.activatePrepared(identity), /Voice request failed/);
		await assert.rejects(caller.release(identity), /Voice request failed/);
		await assert.rejects(
			caller.speak({ ...identity, speechId: "early", text: "hello" }),
			/Voice request failed/
		);
		await assert.rejects(caller.offer(offer), /Voice request failed/);
		await assert.rejects(
			caller.offerPrepared({ ...offer, sdp: "conflicting" }),
			/Voice request failed/
		);
		assert.deepEqual(
			backend.calls.map(({ path }) => path),
			["offer"]
		);
		response.resolve(answer);
		assert.deepEqual(await first, answer);
		assert.deepEqual(await duplicate, answer);
		await assert.rejects(
			caller.activatePrepared({ ...identity, turnId: "foreign" }),
			/Voice request failed/
		);
		assert.deepEqual(await caller.activatePrepared(identity), { ok: true });
		await assert.rejects(caller.activatePrepared(identity), /Voice request failed/);
		await assert.rejects(caller.offerPrepared(offer), /Voice request failed/);
		await caller.release(identity);
		await caller.speak({ ...identity, speechId: "active", text: "hello" });
		assert.deepEqual(
			backend.calls.map(({ path }) => path),
			["offer", "release", "speak"]
		);
		assert.equal((await manager.status()).phase, "ready");
	});

	it("quietly retires only structured transient provisional offer failures, retaining a healthy service", async (t) => {
		for (const diagnostic of [
			{ stage: "media", code: "network" },
			{ stage: "media", code: "timeout", httpStatus: 408 },
			{ stage: "meta", code: "unavailable", httpStatus: 503 },
		] satisfies VoiceDiagnostic[]) {
			const { manager, sidecars } = fixture(t);
			await ready(manager);
			const backend = sidecars[0] as FakeSidecar;
			backend.handle = async (path) => {
				if (path === "offer") throw new VoiceDiagnosticError(diagnostic);
				return {};
			};
			await assert.rejects(manager.offerPrepared(offer), VoiceDiagnosticError);
			await flush();
			assert.equal((await manager.status()).phase, "ready");
			await assert.rejects(manager.activatePrepared(identity), /Voice request failed/);
			await assert.rejects(manager.offer(offer), /Voice request failed/);
			assert.equal(backend.calls.filter(({ path }) => path === "offer").length, 1);
			assert(backend.calls.some(({ path }) => path === "cancel"));
			backend.handle = async (path) => (path === "offer" ? answer : {});
			await manager.offer({ ...offer, ...next() });
			await manager.release(next());
			assert.equal(sidecars.length, 1);
		}
	});

	it("keeps auth, access, configuration, protocol and unknown provisional failures visible and canonical", async (t) => {
		for (const diagnostic of [
			{ stage: "meta", code: "auth", httpStatus: 401 },
			{ stage: "meta", code: "access", httpStatus: 403 },
			{ stage: "meta", code: "rate-limit", httpStatus: 429 },
			{ stage: "media", code: "tls" },
			{ stage: "setup", code: "unavailable" },
			{ stage: "media", code: "protocol" },
			{ stage: "media", code: "invalid-response" },
			{ stage: "meta", code: "network", httpStatus: 401 },
			{ stage: "media", code: "unavailable", httpStatus: 302 },
			undefined,
		] satisfies (VoiceDiagnostic | undefined)[]) {
			const { manager, sidecars } = fixture(t);
			await ready(manager);
			const failure = diagnostic ? new VoiceDiagnosticError(diagnostic) : new Error(secret);
			(sidecars[0] as FakeSidecar).handle = async (path) => {
				if (path === "offer") throw failure;
				throw new VoiceDiagnosticError({ stage: "media", code: "failed" });
			};
			await assert.rejects(manager.offerPrepared(offer), (error: Error) => {
				assert.equal(error.message.includes(secret), false);
				if (diagnostic) assert.equal(error.message, failure.message);
				return true;
			});
			await flush();
			const status = await manager.status();
			assert.equal(status.phase, "error");
			assert.equal(JSON.stringify(status).includes(secret), false);
			if (diagnostic)
				assert.equal(status.error, failure.message, "cleanup cannot replace the first failure");
			await assert.rejects(manager.activatePrepared(identity), /Voice request failed/);
		}
	});

	it("classifies provisional poll errors only after validating the entire batch", async (t) => {
		const transient = { stage: "media", code: "network" } as const;
		const auth = { stage: "meta", code: "auth", httpStatus: 401 } as const;
		for (const mode of [
			"transient",
			"auth",
			"transient-then-auth",
			"foreign",
			"sequence",
			"unknown",
			"malformed",
		] as const) {
			const { manager, caller, sidecars } = fixture(t);
			await ready(manager);
			await caller.offerPrepared(offer);
			const backend = sidecars[0] as FakeSidecar;
			backend.handle = async (path) => {
				if (path !== "poll") return {};
				if (mode === "malformed") return { events: [{ message: secret }] };
				return {
					events:
						mode === "transient-then-auth"
							? [errorEvent(transient), errorEvent(auth, identity, 2)]
							: [
									errorEvent(
										mode === "unknown" ? undefined : mode === "auth" ? auth : transient,
										mode === "foreign" ? next() : identity
									),
								],
				};
			};
			const polled = caller.poll({ ...identity, afterSequence: mode === "sequence" ? 1 : 0 });
			if (["auth", "transient-then-auth", "unknown"].includes(mode)) {
				const result = await polled;
				assert.equal(JSON.stringify(result).includes(secret), false);
			} else await assert.rejects(polled);
			await flush();
			const status = await manager.status();
			assert.equal(status.phase, mode === "transient" ? "ready" : "error", mode);
			assert.equal(JSON.stringify(status).includes(secret), false);
			if (mode === "auth" || mode === "transient-then-auth")
				assert.match(status.error ?? "", /Meta speech authentication failed/);
			await assert.rejects(manager.activatePrepared(identity), /Voice request failed/);
		}
	});

	it("applies ordinary error policy when a provisional poll fails after activation", async (t) => {
		for (const mode of ["throw", "event"] as const) {
			const { manager, sidecars } = fixture(t);
			await ready(manager);
			await manager.offerPrepared(offer);
			const response = deferred<unknown>();
			const backend = sidecars[0] as FakeSidecar;
			backend.handle = async () => response.promise;
			const polled = manager.poll({ ...identity, afterSequence: 0 });
			const outcome = mode === "throw" ? assert.rejects(polled, VoiceDiagnosticError) : polled;
			await flush();
			const activation = manager.activatePrepared(identity);
			// Complete the backend in the same turn, before the caller receives activation's ack.
			if (mode === "throw")
				response.reject(new VoiceDiagnosticError({ stage: "media", code: "network" }));
			else response.resolve({ events: [errorEvent({ stage: "media", code: "network" })] });
			assert.deepEqual(await activation, { ok: true });
			await outcome;
			assert.equal((await manager.status()).phase, "error");
			response.resolve({});
		}
	});

	it("compensates a replaced late offer or auth failure without cancelling or poisoning the newer session", async (t) => {
		for (const late of ["answer", "auth"] as const) {
			const { manager, sidecars } = fixture(t);
			await ready(manager);
			const backend = sidecars[0] as FakeSidecar;
			const response = deferred<unknown>();
			backend.handle = async (path, body) => {
				if (path === "offer")
					return (body as TurnIdentity).generation === 1 ? response.promise : answer;
				if (path === "cancel") throw new VoiceDiagnosticError({ stage: "media", code: "protocol" });
				return {};
			};
			const old = manager.offerPrepared(offer);
			const rejected = assert.rejects(old);
			await flush();
			await manager.offerPrepared({ ...offer, ...next() });
			await manager.cancel(identity); // The old cancel must not retire the new candidate.
			assert.deepEqual(await manager.activatePrepared(next()), { ok: true });
			assert(backend.calls.find(({ path }) => path === "offer")?.signal?.aborted);
			if (late === "auth")
				response.reject(new VoiceDiagnosticError({ stage: "meta", code: "auth" }));
			else response.resolve(answer);
			await rejected;
			await flush();
			await manager.speak({ ...next(), speechId: "new", text: "still active" });
			assert.equal((await manager.status()).phase, "ready");
			const cancels = backend.calls.filter(({ path }) => path === "cancel");
			assert(cancels.length >= 2, "initial retirement and late-offer compensation both run");
			assert(cancels.every(({ body }) => (body as TurnIdentity).generation === 1));
		}
	});

	it("exact cancellation fences a pending prepared offer and retains its high-water tombstone", async (t) => {
		const { manager, sidecars } = fixture(t);
		await ready(manager);
		const backend = sidecars[0] as FakeSidecar;
		const response = deferred<unknown>();
		backend.handle = async (path) => (path === "offer" ? response.promise : {});
		const old = manager.offerPrepared(offer);
		const rejected = assert.rejects(old);
		await flush();
		const cancelled = manager.cancel(identity);
		await assert.rejects(manager.activatePrepared(identity));
		response.resolve(answer);
		await Promise.all([cancelled, rejected]);
		await assert.rejects(manager.offerPrepared(offer));
		assert.deepEqual(
			backend.calls.map(({ path }) => path),
			["offer", "cancel", "cancel"]
		);
		assert.equal((await manager.status()).phase, "ready");
	});

	it("measures lease from admission, not readiness, and duplicate offers never renew it", async (t) => {
		for (const heldOffer of [true, false]) {
			let now = 100;
			const { manager, sidecars } = fixture(t, { now: () => now });
			await ready(manager);
			const backend = sidecars[0] as FakeSidecar;
			const response = deferred<unknown>();
			backend.handle = async (path) => (path === "offer" ? response.promise : {});
			const offered = manager.offerPrepared(offer);
			const rejected = heldOffer ? assert.rejects(offered) : undefined;
			await flush();
			if (!heldOffer) {
				response.resolve(answer);
				await offered;
				now = 20_099;
				assert.deepEqual(await manager.offerPrepared(offer), answer);
			}
			now = 20_100;
			if (heldOffer) {
				response.resolve(answer);
				await rejected;
			}
			await assert.rejects(manager.activatePrepared(identity));
			await flush();
			assert.equal(backend.calls.filter(({ path }) => path === "offer").length, 1);
			assert(backend.calls.some(({ path }) => path === "cancel"));
			assert.equal((await manager.status()).phase, "ready");
		}
	});

	it("server timer retires an idle candidate once and never auto-reconnects", async (t) => {
		const { manager, sidecars } = fixture(t, { preparedLeaseMs: 5, now: () => 0 });
		await ready(manager);
		await manager.offerPrepared(offer);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await assert.rejects(manager.activatePrepared(identity));
		const backend = sidecars[0] as FakeSidecar;
		assert.deepEqual(
			backend.calls.map(({ path }) => path),
			["offer", "cancel"]
		);
		await manager.dispose();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(
			backend.calls.map(({ path }) => path),
			["offer", "cancel"]
		);
		assert.equal(sidecars.length, 1);
	});

	it("activation clears the timer before acknowledgement and exact later cancellation remains ordinary", async (t) => {
		const { manager, sidecars } = fixture(t, { preparedLeaseMs: 30 });
		await ready(manager);
		await manager.offerPrepared(offer);
		assert.deepEqual(await manager.activatePrepared(identity), { ok: true });
		await new Promise((resolve) => setTimeout(resolve, 40));
		await manager.release(identity);
		assert.deepEqual(
			sidecars[0]?.calls.map(({ path }) => path),
			["offer", "release"]
		);
		await manager.cancel(identity);
		await assert.rejects(manager.activatePrepared(identity));
	});

	it("configuration, credential replacement and shutdown retire provisional state and prohibit reuse", async (t) => {
		for (const change of ["configure", "credentials", "dispose"] as const) {
			const { manager, state, sidecars } = fixture(t, { preparedLeaseMs: 30 });
			await ready(manager);
			await manager.offerPrepared(offer);
			if (change === "configure") await manager.configure({ voiceId: "new-public-voice" });
			if (change === "credentials") {
				state.credentials = { ...state.credentials, meta: "replacement-main-only" };
				assert.equal((await manager.status()).phase, "stopped");
			}
			if (change === "dispose") await manager.dispose();
			await assert.rejects(manager.activatePrepared(identity));
			await flush();
			const before = sidecars[0]?.calls.length;
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(sidecars[0]?.calls.length, before, "retired service retains no lease timer");
			if (change !== "dispose") {
				await ready(manager);
				await assert.rejects(manager.offerPrepared(offer));
				await manager.offerPrepared({ ...offer, ...next() });
				assert.deepEqual(await manager.activatePrepared(next()), { ok: true });
				assert.equal(sidecars.length, 2);
			}
		}
	});

	it("a terminal provisional transcript retires the candidate without admission to actual capture", async (t) => {
		const { manager, sidecars } = fixture(t);
		await ready(manager);
		await manager.offerPrepared(offer);
		(sidecars[0] as FakeSidecar).handle = async (path) =>
			path === "poll"
				? { events: [{ ...identity, kind: "transcript", sequence: 1, text: "", final: true }] }
				: {};
		await assert.rejects(manager.poll({ ...identity, afterSequence: 0 }));
		await assert.rejects(manager.activatePrepared(identity));
		assert.equal((await manager.status()).phase, "ready");
	});

	it("validates lease options, clock values and both RPC inputs without starting media", async (t) => {
		for (const preparedLeaseMs of [0, -1, 20_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
			assert.throws(
				() =>
					createVoiceComposition({
						getCredentials: async () => ({}),
						getDataDirectory: () => "/unused",
						command: "/unused",
						executableAvailable: () => false,
						preparedLeaseMs,
					}),
				/lease/
			);
		const { manager, caller, sidecars } = fixture(t, { now: () => Number.NaN });
		await assert.rejects(caller.offerPrepared({ ...offer, generation: -1 }));
		await assert.rejects(caller.activatePrepared({ ...identity, generation: -1 }));
		await assert.rejects(caller.activatePrepared({ ...identity, extra: secret } as TurnIdentity));
		assert.equal(sidecars.length, 0);
		await ready(manager);
		await assert.rejects(caller.offerPrepared(offer));
		assert.equal(sidecars[0]?.calls.length, 0);
	});
});

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

for (const finalFirst of [false, true])
	it(`trusted Stop callback requires capture release and a final transcript, once: ${finalFirst}`, async (t) => {
		const stopped: TurnIdentity[] = [];
		const f = fixture(t, { onStopSpeech: (value) => stopped.push(value) });
		await ready(f.manager);
		await f.caller.offer(offer);
		const backend = f.sidecars[0];
		assert(backend);
		let text = "Stop.";
		let final = false;
		let sequence = 1;
		backend.handle = async (path) =>
			path === "poll"
				? { events: [{ ...identity, sequence, kind: "transcript", text, final }] }
				: {};
		await f.caller.poll({ ...identity, afterSequence: 0 });
		assert.equal(stopped.length, 0);
		final = true;
		sequence = 2;
		if (!finalFirst) await f.caller.release(identity);
		await f.caller.poll({ ...identity, afterSequence: 1 });
		if (finalFirst) {
			assert.equal(stopped.length, 0);
			await f.caller.release(identity);
		}
		assert.deepEqual(stopped, [identity]);
		await f.caller.poll({ ...identity, afterSequence: 1 });
		assert.equal(stopped.length, 1);
		text = "Stop the coding worker";
		await f.caller.cancel(identity);
		assert.equal(stopped.length, 1);
	});
it("non-Stop finals and retired voice polls cannot revoke a newer confirmation", async (t) => {
	const stopped: TurnIdentity[] = [];
	const f = fixture(t, { onStopSpeech: (value) => stopped.push(value) });
	await ready(f.manager);
	await f.caller.offer(offer);
	const backend = f.sidecars[0];
	assert(backend);
	backend.handle = async (path) =>
		path === "poll"
			? {
					events: [
						{ ...identity, sequence: 1, kind: "transcript", text: "Stop the worker", final: true },
					],
				}
			: {};
	await f.caller.release(identity);
	await f.caller.poll({ ...identity, afterSequence: 0 });
	assert.equal(stopped.length, 0);
	await f.caller.cancel(identity);
	backend.handle = async (path) =>
		path === "poll"
			? { events: [{ ...identity, sequence: 2, kind: "transcript", text: "Stop.", final: true }] }
			: {};
	await f.caller.poll({ ...identity, afterSequence: 1 }).catch(() => {});
	assert.equal(stopped.length, 0);
});

it("an in-flight Stop transcript cannot revoke consent after its voice turn is cancelled", async (t) => {
	const stopped: TurnIdentity[] = [];
	const f = fixture(t, { onStopSpeech: (value) => stopped.push(value) });
	await ready(f.manager);
	await f.caller.offer(offer);
	await f.caller.release(identity);
	const backend = f.sidecars[0];
	assert(backend);
	const pending = deferred<unknown>();
	let polling = false;
	backend.handle = async (path) => {
		if (path === "poll") {
			polling = true;
			return pending.promise;
		}
		return {};
	};
	const polled = f.caller.poll({ ...identity, afterSequence: 0 });
	await flush();
	assert(polling);
	const cancelled = f.caller.cancel(identity);
	await flush();
	pending.resolve({
		events: [{ ...identity, sequence: 1, kind: "transcript", text: "Stop.", final: true }],
	});
	await Promise.all([cancelled, polled.catch(() => {})]);
	assert.equal(stopped.length, 0);
});
