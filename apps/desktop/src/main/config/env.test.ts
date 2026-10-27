import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, describe, it } from "node:test";
import { parseEnv } from "node:util";
import type { CredentialProvider } from "../../shared/contracts";
import { EnvConfiguration } from "./env";

async function fixture(t: TestContext, text?: string) {
	const directory = await mkdtemp(join(tmpdir(), "met-8-env-test-"));
	const path = join(directory, ".env");
	t.after(() => rm(directory, { recursive: true, force: true }));
	if (text !== undefined) await writeFile(path, text);
	return { directory, path, env: new EnvConfiguration(path) };
}

describe("main-only environment configuration", () => {
	it("treats a missing file as empty and reports only provider presence", async (t) => {
		const { env, directory } = await fixture(t);
		assert.equal(await env.get("github"), undefined);
		assert.equal(await env.get("meta"), undefined);
		assert.equal(await env.voiceId(), undefined);
		await env.reload();
		await env.delete("github");
		await env.migrate({});
		assert.deepEqual(await env.status(), [
			{ provider: "github", configured: false, storage: "env-file" },
			{ provider: "meta", configured: false, storage: "env-file" },
			{ provider: "elevenlabs", configured: false, storage: "env-file" },
		]);
		assert.deepEqual(await readdir(directory), []);
	});
	it("creates an owner-only template once and preserves an existing file", async (t) => {
		const { env, path, directory } = await fixture(t);
		await Promise.all([env.ensureTemplate(), new EnvConfiguration(path).ensureTemplate()]);
		const template = await readFile(path, "utf8");
		assert.match(template, /#.*private/);
		assert.deepEqual(parseEnv(template), {
			GITHUB_TOKEN: "",
			MODEL_API_KEY: "",
			ELEVENLABS_API_KEY: "",
			ELEVENLABS_VOICE_ID: "",
		});
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		await env.set("meta", "fake-meta");
		const updated = await readFile(path, "utf8");
		await env.ensureTemplate();
		assert.equal(await readFile(path, "utf8"), updated);
		assert.deepEqual(await readdir(directory), [".env"]);
	});
	it("uses canonical credentials first and aliases only when canonical keys are absent", async (t) => {
		const { env, path } = await fixture(
			t,
			"GH_TOKEN=fake-gh-alias\nMETA_API_KEY=fake-meta-alias\n"
		);
		assert.equal(await env.get("github"), "fake-gh-alias");
		assert.equal(await env.get("meta"), "fake-meta-alias");
		await writeFile(
			path,
			"GH_TOKEN=fake-gh-alias\nGITHUB_TOKEN=\nMETA_API_KEY=fake-meta-alias\nMODEL_API_KEY=fake-meta-canonical\n"
		);
		await env.reload();
		assert.equal(await env.get("github"), undefined);
		assert.equal(await env.get("meta"), "fake-meta-canonical");
	});
	it("atomically replaces an existing file with owner-only permissions", async (t) => {
		const { env, path, directory } = await fixture(t, "MODEL_API_KEY=fake-old\n");
		const previous = await open(path, "r");
		try {
			await env.set("meta", "fake-new");
			assert.equal(await previous.readFile("utf8"), "MODEL_API_KEY=fake-old\n");
			assert.equal(await env.get("meta"), "fake-new");
			assert.equal((await stat(path)).mode & 0o777, 0o600);
			assert.deepEqual(await readdir(directory), [".env"]);
		} finally {
			await previous.close();
		}
	});
	it("serializes writes and reads without losing another provider or voice ID", async (t) => {
		const { env, path, directory } = await fixture(t);
		const outcomes = await Promise.all([
			env.set("github", "  fake-github  "),
			env.get("github"),
			env.set("meta", "fake-meta"),
			env.set("elevenlabs", "fake-eleven"),
			env.setVoiceId("public-voice"),
			env.delete("meta"),
			env.get("meta"),
		]);
		assert.equal(outcomes[1], "fake-github");
		assert.equal(outcomes[6], undefined);
		assert.equal(await env.voiceId(), "public-voice");
		assert.equal(await env.get("elevenlabs"), "fake-eleven");
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.deepEqual(await readdir(directory), [".env"]);
		assert.deepEqual(await env.status(), [
			{ provider: "github", configured: true, storage: "env-file" },
			{ provider: "meta", configured: false, storage: "env-file" },
			{ provider: "elevenlabs", configured: true, storage: "env-file" },
		]);
	});
	it("preserves comments, CRLF, exports and unrelated quoted multiline assignments", async (t) => {
		const original =
			"# Keep this header\r\nexport MODEL_API_KEY = 'fake-old'  # keep meta note\r\nUNRELATED='line one\r\nMODEL_API_KEY=inside-unrelated\r\nline three' # keep tail\r\nOTHER=unchanged\r\n# End";
		const { env, path } = await fixture(t, original);
		await env.set("meta", "fake-new");
		assert.equal(await readFile(path, "utf8"), original.replace("'fake-old'", "'fake-new'"));
		assert.equal(await env.get("meta"), "fake-new");
		await env.setVoiceId("public-voice");
		assert.ok(
			(await readFile(path, "utf8")).endsWith("# End\r\nELEVENLABS_VOICE_ID='public-voice'\r\n")
		);
	});
	it("updates duplicate assignments and clears aliases without removing comments", async (t) => {
		const { env, path } = await fixture(
			t,
			"# header\nGITHUB_TOKEN=fake-first # first\nexport GITHUB_TOKEN='fake-last' # second\nGH_TOKEN=fake-alias # alias\nOTHER=keep\n"
		);
		assert.equal(await env.get("github"), "fake-last");
		await env.set("github", "fake-replacement");
		const updated = await readFile(path, "utf8");
		assert.equal(updated.includes("fake-first"), false);
		assert.equal(updated.includes("fake-last"), false);
		await env.delete("github");
		assert.equal(await env.get("github"), undefined);
		const deleted = await readFile(path, "utf8");
		assert.equal(deleted.includes("fake-"), false);
		assert.match(deleted, /# first/);
		assert.match(deleted, /# second/);
		assert.match(deleted, /# alias/);
		assert.match(deleted, /OTHER=keep/);
	});
	it("round-trips supported quoting without interpolation or injected assignments", async (t) => {
		const { env, path } = await fixture(t);
		for (const fake of [
			"fake#hash",
			"fake'quote",
			"fake'and\"quotes",
			"fake\\nliteral",
			"fake $NOT_EXPANDED $(nothing)",
			"fake`tick'and\"double",
		]) {
			await env.set("meta", fake);
			assert.equal(await env.get("meta"), fake);
			assert.deepEqual(Object.keys(parseEnv(await readFile(path, "utf8"))), ["MODEL_API_KEY"]);
		}
	});
	it("migrates only missing values, preserving canonical values, aliases and voice ID", async (t) => {
		const { env, path } = await fixture(
			t,
			"# preserve me\nGH_TOKEN=fake-existing-github\nMODEL_API_KEY=fake-existing-meta\nELEVENLABS_API_KEY=\nELEVENLABS_VOICE_ID=public-existing\nOTHER=keep\n"
		);
		await env.migrate({
			github: "fake-migration-github",
			meta: "fake-migration-meta",
			elevenlabs: "fake-migration-eleven",
			voiceId: "public-migration",
		});
		assert.equal(await env.get("github"), "fake-existing-github");
		assert.equal(await env.get("meta"), "fake-existing-meta");
		assert.equal(await env.get("elevenlabs"), "fake-migration-eleven");
		assert.equal(await env.voiceId(), "public-existing");
		const text = await readFile(path, "utf8");
		assert.match(text, /^# preserve me\n/);
		assert.match(text, /OTHER=keep/);
		assert.equal(text.includes("fake-migration-meta"), false);
		assert.equal(text.includes("GITHUB_TOKEN"), false);
		await env.migrate({ github: "another-fake", meta: "another-fake" });
		assert.equal(await readFile(path, "utf8"), text);
	});
	it("migrates empty templates and supports external edits and deletion on reload", async (t) => {
		const { env, path } = await fixture(t);
		await env.ensureTemplate();
		await env.migrate({
			github: "fake-gh",
			meta: "fake-meta",
			elevenlabs: "fake-eleven",
			voiceId: "public-voice",
		});
		assert.equal(
			(await env.status()).every((row) => row.configured),
			true
		);
		assert.equal(await env.voiceId(), "public-voice");
		await writeFile(path, "MODEL_API_KEY=fake-edited\n");
		await env.reload();
		assert.equal(await env.get("meta"), "fake-edited");
		assert.equal(await env.get("github"), undefined);
		await rm(path);
		await env.reload();
		assert.equal(await env.get("meta"), undefined);
	});
	it("rejects unsafe or oversized writes without changing the file and recovers the queue", async (t) => {
		const { env, path } = await fixture(t, "MODEL_API_KEY=fake-existing\n");
		for (const invalid of [
			"fake-secret\nGITHUB_TOKEN=injected",
			"fake-secret\rnext",
			"fake-secret\0",
			"",
			"  ",
			"x".repeat(16_385),
			"fake'\"`#unrepresentable",
		]) {
			await assert.rejects(
				env.set("meta", invalid),
				(error: Error) => !error.message.includes("fake-secret")
			);
		}
		await assert.rejects(env.set("fake-secret" as CredentialProvider, "fake-input"));
		await assert.rejects(env.setVoiceId(`${" ".repeat(201)}voice`));
		await assert.rejects(env.migrate({ github: "fake-valid", meta: "fake-invalid\n" }));
		assert.equal(await readFile(path, "utf8"), "MODEL_API_KEY=fake-existing\n");
		await env.set("meta", "fake-recovered");
		assert.equal(await env.get("meta"), "fake-recovered");
	});
	it("validates rereads and never forwards malformed file contents or paths in errors", async (t) => {
		const { env, path } = await fixture(t);
		for (const malformed of [
			"fake-secret invalid line\n",
			"MODEL_API_KEY='fake-secret\n",
			"MODEL_API_KEY=   'fake-secret\n",
			"MODEL_API_KEY=   'fake-secret' trailing-text\n",
			"MODEL_API_KEY='fake-secret\nsecond-line'\n",
			'MODEL_API_KEY="fake-secret\\nline"\n',
			"OTHER=fake-secret\0",
			`MODEL_API_KEY=${"x".repeat(16_385)}`,
			`ELEVENLABS_VOICE_ID=${"x".repeat(201)}`,
			`#${"x".repeat(1_048_576)}`,
		]) {
			await writeFile(path, malformed);
			for (const operation of [env.reload(), env.status(), env.set("github", "fake-new")]) {
				await assert.rejects(
					operation,
					(error: Error) =>
						error.message === "Invalid or inaccessible local environment configuration"
				);
			}
			assert.equal(await readFile(path, "utf8"), malformed);
		}
		await writeFile(path, Buffer.from([0xff, 0xfe]));
		await assert.rejects(env.reload());
	});
	it("handles UTF-8 BOM and rejects non-files with sanitized errors", async (t) => {
		const { env, path, directory } = await fixture(
			t,
			"\uFEFFMODEL_API_KEY=fake-old\n# unchanged\n"
		);
		await env.set("meta", "fake-new");
		assert.equal(await readFile(path, "utf8"), "\uFEFFMODEL_API_KEY='fake-new'\n# unchanged\n");
		const bad = join(directory, "fake-secret-directory");
		await mkdir(bad);
		await assert.rejects(
			new EnvConfiguration(bad).ensureTemplate(),
			(error: Error) => !error.message.includes("fake-secret")
		);
	});
});
