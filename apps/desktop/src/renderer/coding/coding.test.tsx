import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodingProviderStatus } from "../../shared/contracts/coding-provider";
import { CodingProviderCard, CodingProviderForm } from "./CodingProviderCard";
import { type CodingProviderClock, createCodingProviderController } from "./controller";
import { CODING_ERRORS, MUSE_CODE_ERRORS, codingReady } from "./model";

function status(provider: "meta-api" | "muse-code" = "meta-api"): CodingProviderStatus {
	return {
		settings: { provider, musePath: null },
		metaApiConfigured: true,
		museCode: {
			installed: true,
			version: "1.4.13",
			auth: "account",
			billing: "subscription",
			tier: "Pro",
			ready: true,
			error: null,
		},
		ready: true,
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function fakeClock() {
	const tasks = new Set<{ ms: number; callback(): void }>();
	const clock: CodingProviderClock = {
		schedule(callback, ms) {
			const task = { ms, callback };
			tasks.add(task);
			return () => {
				tasks.delete(task);
			};
		},
	};
	return {
		clock,
		tasks,
		fire(ms: number) {
			const task = [...tasks].find((task) => task.ms === ms);
			assert.ok(task, `Expected scheduled ${ms}ms`);
			tasks.delete(task);
			task.callback();
		},
	};
}
function harness(override?: (path: string, input: unknown) => unknown) {
	let current = status();
	const calls: { type: string; path: string; input: unknown }[] = [];
	const time = fakeClock();
	const controller = createCodingProviderController(
		async (type, path, input) => {
			calls.push({ type, path, input: structuredClone(input) });
			const custom = override?.(path, input);
			if (custom !== undefined) return custom;
			if (path === "codingProvider.openLogin") return undefined;
			if (path === "codingProvider.configure")
				current = { ...current, settings: input as CodingProviderStatus["settings"] };
			return current;
		},
		{ clock: time.clock }
	);
	const ssr = () => ({
		...controller,
		store: { ...controller.store, getInitialState: controller.store.getState },
	});
	return {
		controller,
		calls,
		time,
		setStatus(next: CodingProviderStatus) {
			current = next;
		},
		html: () => renderToStaticMarkup(<CodingProviderForm controller={ssr()} />),
	};
}
async function ticks() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("SSR performs no calls and renders explicit provider choices with no key input", () => {
	let calls = 0;
	const html = renderToStaticMarkup(
		<CodingProviderCard
			call={async () => {
				calls++;
				throw new Error("No calls in SSR");
			}}
		/>
	);
	assert.equal(calls, 0);
	assert.match(html, /Background coding provider/);
	assert.match(html, /type="radio"/);
	assert.match(html, /existing CLI account and subscription/);
	assert.match(html, /Pay-as-you-go API billing/);
	assert.doesNotMatch(html, /type="password"|checked=""|token=|Supabase|upload/i);
	assert.match(html, /data-coding-provider="unknown"/);
	assert.match(html, /data-coding-ready="false"/);
	assert.match(html, /no automatic fallback/);
	assert.match(html, /does not power ElevenLabs voice/);
	assert.match(html, /Existing jobs keep their pinned provider/);
});

test("provider choice and advanced path are drafts until exact explicit save", async () => {
	const h = harness();
	await h.controller.observe();
	h.controller.setProvider("muse-code");
	h.controller.setMusePath("/Applications/Muse Code/bin/muse");
	assert.equal(h.calls.length, 1);
	assert.match(h.html(), /Unsaved selection/);
	const saved = await h.controller.save();
	assert.equal(saved?.settings.provider, "muse-code");
	assert.deepEqual(h.calls.at(-1), {
		type: "mutation",
		path: "codingProvider.configure",
		input: { provider: "muse-code", musePath: "/Applications/Muse Code/bin/muse" },
	});
	assert.match(h.html(), /data-coding-provider="muse-code"/);
	assert.match(h.html(), /data-coding-ready="true"/);
	assert.doesNotMatch(h.html(), /Unsaved selection/);
	assert.equal(h.time.tasks.size, 0, "An unmounted explicit check starts no polling");
});

test("empty CLI path saves null for Auto; relative paths and control characters never reach main", async () => {
	const h = harness();
	await h.controller.observe();
	h.controller.setProvider("muse-code");
	for (const path of [
		"muse",
		"~/bin/muse",
		"file:///usr/bin/muse",
		"/usr/bin/\nmuse",
		"/bin/\u0000muse",
		"C:\\muse.exe",
	]) {
		h.controller.setMusePath(path);
		assert.equal(await h.controller.save(), null);
		assert.equal(h.controller.store.getState().error, "path");
	}
	assert.equal(h.calls.length, 1);
	h.controller.setMusePath("   ");
	await h.controller.save();
	assert.deepEqual(h.calls.at(-1)?.input, { provider: "muse-code", musePath: null });
});

test("status polling does not overwrite an unsaved provider/path draft", async () => {
	const h = harness();
	await h.controller.observe();
	h.controller.setProvider("muse-code");
	h.controller.setMusePath("/custom/muse");
	await h.controller.observe();
	assert.deepEqual(h.controller.store.getState().draft, {
		provider: "muse-code",
		musePath: "/custom/muse",
	});
	assert.equal(h.controller.store.getState().status?.settings.provider, "meta-api");
	assert.equal(
		h.calls.some((call) => call.path === "codingProvider.configure"),
		false
	);
});

test("an older status response cannot overwrite a subsequent configured provider", async () => {
	const old = deferred<unknown>();
	let delayed = false;
	const h = harness((path) =>
		path === "codingProvider.status" && delayed ? old.promise : undefined
	);
	await h.controller.observe();
	delayed = true;
	const reading = h.controller.observe();
	await ticks();
	h.controller.setProvider("muse-code");
	await h.controller.save();
	old.resolve(status("meta-api"));
	await reading;
	await ticks();
	assert.equal(h.controller.store.getState().status?.settings.provider, "muse-code");
	assert.equal(h.controller.store.getState().draft?.provider, "muse-code");
});

test("an in-flight save preserves newer local edits and cannot claim they were applied", async () => {
	const pending = deferred<unknown>();
	const h = harness((path) => (path === "codingProvider.configure" ? pending.promise : undefined));
	await h.controller.observe();
	h.controller.setProvider("muse-code");
	const save = h.controller.save();
	await ticks();
	h.controller.setProvider("meta-api");
	h.controller.setMusePath("/newer/muse");
	pending.resolve(status("muse-code"));
	await save;
	assert.equal(h.controller.store.getState().status?.settings.provider, "muse-code");
	assert.deepEqual(h.controller.store.getState().draft, {
		provider: "meta-api",
		musePath: "/newer/muse",
	});
	assert.match(h.html(), /Unsaved selection/);
});

test("mismatched save responses fail closed with no API billing fallback", async () => {
	const h = harness((path) =>
		path === "codingProvider.configure" ? status("meta-api") : undefined
	);
	await h.controller.observe();
	h.controller.setProvider("muse-code");
	assert.equal(await h.controller.save(), null);
	assert.equal(h.controller.store.getState().verified, false);
	assert.equal(h.controller.store.getState().error, "configure");
	assert.equal(h.controller.store.getState().draft?.provider, "muse-code");
	assert.deepEqual(
		h.calls.filter((call) => call.path === "codingProvider.configure").map((call) => call.input),
		[{ provider: "muse-code", musePath: null }]
	);
	assert.match(h.html(), /data-coding-ready="false"/);
});

test("quota/auth/billing/unsupported/missing/unknown statuses never imply subscription readiness", async () => {
	const cases = [
		{ error: "quota-exceeded" as const },
		{ error: "unsupported-cli" as const },
		{
			auth: "api-key" as const,
			billing: "pay-as-you-go" as const,
			error: "api-key-selected" as const,
		},
		{ auth: "sign-in-required" as const, error: "sign-in-required" as const },
		{ installed: false, error: "not-installed" as const },
		{ auth: "unknown" as const },
		{ billing: "unknown" as const },
		{ billing: "pay-as-you-go" as const },
		{ ready: false },
	];
	for (const partial of cases) {
		const h = harness();
		const value = status("muse-code");
		value.museCode = { ...value.museCode, ...partial };
		// Even an inconsistent top-level ready flag cannot silently bypass subscription checks.
		h.setStatus(value);
		await h.controller.observe();
		assert.equal(codingReady(value), false);
		assert.match(h.html(), /Not ready for new coding jobs/);
		assert.match(h.html(), /data-coding-ready="false"/);
		assert.equal(
			h.calls.some((call) => call.path === "codingProvider.configure"),
			false
		);
		if (partial.error) assert.ok(h.html().includes(MUSE_CODE_ERRORS[partial.error]));
	}
});

test("missing custom executable is explicit and sign-in is blocked until it is found", async () => {
	const h = harness();
	const value = status("muse-code");
	value.settings.musePath = "/missing/muse";
	value.museCode.installed = false;
	value.museCode.error = "not-installed";
	value.museCode.version = null;
	h.setStatus(value);
	await h.controller.observe();
	assert.match(h.html(), /Muse Code was not found/);
	assert.match(h.html(), /value="\/missing\/muse"/);
	assert.equal(h.controller.canOpenLogin(), false);
	await h.controller.openLogin();
	assert.equal(h.calls.length, 1);
});

test("Open Muse Code sign-in only launches the root flow; it never reports signed-in success", async () => {
	const h = harness();
	const value = status("muse-code");
	value.museCode.auth = "sign-in-required";
	value.museCode.error = "sign-in-required";
	value.museCode.ready = false;
	value.ready = false;
	h.setStatus(value);
	await h.controller.observe();
	assert.equal(h.controller.canOpenLogin(), true);
	await h.controller.openLogin();
	assert.deepEqual(h.calls.at(-1), {
		type: "mutation",
		path: "codingProvider.openLogin",
		input: {},
	});
	assert.equal(h.controller.store.getState().verified, false);
	assert.equal(h.controller.store.getState().status?.museCode.auth, "sign-in-required");
	assert.match(h.html(), /Sign-in was requested/);
	assert.match(h.html(), /data-coding-ready="false"/);
	await h.controller.refresh();
	assert.equal(h.controller.store.getState().status?.ready, false);
	assert.deepEqual(h.calls.at(-1), { type: "mutation", path: "codingProvider.refresh", input: {} });
});

test("unsaved path/provider cannot launch sign-in against a different configured executable", async () => {
	const h = harness();
	h.setStatus(status("muse-code"));
	await h.controller.observe();
	h.controller.setMusePath("/different/muse");
	assert.equal(h.controller.canOpenLogin(), false);
	await h.controller.openLogin();
	assert.equal(h.calls.length, 1);
	assert.match(h.html(), /Save your provider and CLI path/);
});

test("stale save/status/login after reset or disposal cannot publish status or success notices", async () => {
	for (const route of [
		"codingProvider.status",
		"codingProvider.configure",
		"codingProvider.openLogin",
	]) {
		const pending = deferred<unknown>();
		let delayed = false;
		const h = harness((path) => (path === route && delayed ? pending.promise : undefined));
		h.setStatus(status("muse-code"));
		await h.controller.observe();
		delayed = true;
		const work =
			route === "codingProvider.configure"
				? h.controller.save()
				: route === "codingProvider.openLogin"
					? h.controller.openLogin()
					: h.controller.observe();
		await ticks();
		h.controller.reset();
		assert.equal(h.controller.store.getState().status, null);
		assert.equal(h.time.tasks.size, 0);
		pending.resolve(route === "codingProvider.openLogin" ? undefined : status("muse-code"));
		await work;
		await ticks();
		assert.equal(h.controller.store.getState().status, null);
		assert.equal(h.controller.store.getState().notice, "");
		h.controller.dispose();
		await h.controller.observe();
		assert.equal(h.time.tasks.size, 0);
	}
});

test("checks have a bounded local deadline and late replies cannot reverse timeout state", async () => {
	const pending = deferred<unknown>();
	const h = harness(() => pending.promise);
	const work = h.controller.observe();
	await ticks();
	h.time.fire(20000);
	assert.equal(await work, null);
	assert.equal(h.controller.store.getState().error, "timeout");
	assert.equal(h.controller.store.getState().pending, null);
	assert.equal(h.time.tasks.size, 0);
	pending.resolve(status());
	await ticks();
	assert.equal(h.controller.store.getState().status, null);
	assert.match(h.html(), /timed out/);
});

test("polling runs only while mounted; stop cancels timers and even queued dispatch", async () => {
	const h = harness();
	assert.equal(h.time.tasks.size, 0);
	await h.controller.start();
	assert.equal(h.calls.length, 1);
	h.time.fire(5000);
	await ticks();
	await ticks();
	assert.equal(h.calls.length, 2);
	h.controller.stop();
	assert.equal(h.time.tasks.size, 0);
	const work = h.controller.start();
	h.controller.stop();
	await work;
	assert.equal(h.calls.length, 2, "No read dispatch after unmount");
	await h.controller.start();
	assert.equal(h.calls.length, 3, "Strict effect remount can restart");
	h.controller.stop();
	assert.equal(h.time.tasks.size, 0);
});

test("raw backend errors, token fields and untrusted protocol metadata never appear in the card", async () => {
	const secret = "SECRET_TOKEN_DO_NOT_RENDER";
	const failed = harness(() => Promise.reject(new Error(secret)));
	await failed.controller.observe();
	assert.doesNotMatch(failed.html(), new RegExp(secret));
	assert.ok(failed.html().includes(CODING_ERRORS.status));
	const invalid = harness(() => ({ ...status(), token: secret }));
	await invalid.controller.observe();
	assert.equal(invalid.controller.store.getState().status, null);
	assert.doesNotMatch(invalid.html(), new RegExp(secret));
	const metadata = harness();
	const value = status("muse-code");
	value.museCode.version = secret;
	value.museCode.tier = secret;
	metadata.setStatus(value);
	await metadata.controller.observe();
	assert.doesNotMatch(metadata.html(), new RegExp(secret));
});

test("Meta API billing is available only as an explicit selected provider with a configured key", async () => {
	const h = harness();
	const value = status("meta-api");
	value.metaApiConfigured = false;
	h.setStatus(value);
	await h.controller.observe();
	assert.equal(codingReady(value), false);
	assert.match(h.html(), /Configure the Meta API separately/);
	assert.match(h.html(), /data-coding-ready="false"/);
	const cliIssue = status("meta-api");
	cliIssue.museCode.error = "quota-exceeded";
	assert.equal(
		codingReady(cliIssue),
		true,
		"An explicitly saved API choice is independent of CLI quota"
	);
});
