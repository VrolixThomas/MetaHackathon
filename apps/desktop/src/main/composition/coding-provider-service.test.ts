import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, it } from "node:test";
import type { MuseCodeStatus } from "../../shared/contracts";
import { EnvConfiguration } from "../config/env";
import { CodingProviderService } from "./coding-provider-service";

const account: MuseCodeStatus = {
	installed: true,
	version: "1.4.13",
	auth: "account",
	billing: "subscription",
	tier: "pro",
	ready: true,
	error: null,
};
async function setup(t: TestContext, status: MuseCodeStatus = account) {
	const directory = await mkdtemp(join(tmpdir(), "muse-coding-service-"));
	const envPath = join(directory, ".env");
	await writeFile(envPath, "MODEL_API_KEY=fake-api\nELEVENLABS_VOICE_ID=voice-test\n");
	const configuration = new EnvConfiguration(envPath);
	const calls = { probes: 0, opened: [] as string[] };
	const service = new CodingProviderService({
		configuration: () => configuration,
		directory: join(directory, "login"),
		probe: async () => {
			calls.probes++;
			return status;
		},
		resolveBinary: async () => "/tmp/vendor's muse",
		openCommand: async (path) => {
			calls.opened.push(path);
		},
	});
	t.after(async () => {
		await service.dispose();
		await rm(directory, { recursive: true, force: true });
	});
	return { service, calls, configuration, envPath };
}

it("API-only startup does not launch or authenticate the CLI", async (t) => {
	const { service, calls } = await setup(t);
	assert.equal((await service.status()).ready, true);
	assert.equal(await service.readyForCoding(), true);
	assert.equal(calls.probes, 0);
	assert.deepEqual(calls.opened, []);
});
it("explicit subscription selection persists without touching voice/API keys and caches probes", async (t) => {
	const { service, calls, configuration } = await setup(t);
	const result = await service.configure({ provider: "muse-code", musePath: null });
	assert.equal(result.ready, true);
	assert.equal(await configuration.get("meta"), "fake-api");
	assert.equal(await configuration.voiceId(), "voice-test");
	await service.status();
	await service.readyForCoding();
	assert.equal(calls.probes, 1);
	await service.status(true);
	assert.equal(calls.probes, 2);
});
it("a selected subscription with quota exhaustion does not become ready using the configured API", async (t) => {
	const { service } = await setup(t, { ...account, ready: false, error: "quota-exceeded" });
	const result = await service.configure({ provider: "muse-code", musePath: null });
	assert.equal(result.metaApiConfigured, true);
	assert.equal(result.ready, false);
	assert.equal(await service.readyForCoding(), false);
});
it("inconsistent provider readiness is rejected without leaking the provider frame", async (t) => {
	const { service } = await setup(t, { ...account, auth: "api-key" });
	const result = await service.configure({ provider: "muse-code", musePath: null });
	assert.equal(result.ready, false);
	assert.equal(result.museCode.error, "unavailable");
});
it("login is user initiated, shell quoted, private, coalesced and cleaned up on shutdown", async (t) => {
	const { service, calls } = await setup(t, {
		...account,
		auth: "sign-in-required",
		billing: "unknown",
		ready: false,
		error: "sign-in-required",
	});
	assert.deepEqual(calls.opened, []);
	await Promise.all([service.openLogin(), service.openLogin()]);
	assert.equal(calls.opened.length, 1);
	const path = String(calls.opened.at(0));
	assert.equal((await stat(path)).mode & 0o777, 0o700);
	assert.equal(await readFile(path, "utf8"), "#!/bin/sh\nexec '/tmp/vendor'\\''s muse' login\n");
	await service.dispose();
	await assert.rejects(stat(path));
	await assert.rejects(service.status());
});
