import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import {
	ImageError,
	ImageService,
	MUSE_IMAGE_MODEL,
	PrivateImageStore,
	createMuseImageProvider,
} from "./index";
import { inspectRaster } from "./raster";

// Controlled test bytes only: an actual noninterlaced RGB PNG, never a product/provider fallback.
function crc32(bytes: Buffer) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const payload = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(payload));
	return Buffer.concat([length, payload, crc]);
}
function png(width = 1, height = 1) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.alloc((width * 3 + 1) * height))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
const bytes = png();
const raster = () => inspectRaster(bytes, "image/png");
const input = {
	requestId: "controlled-image-1",
	title: "Controlled raster",
	prompt: "Create a red square",
};
const signal = () => new AbortController().signal;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
const response = (data: unknown) =>
	new Response(JSON.stringify(data), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
const imagePayload = (data = bytes.toString("base64")) => ({
	created: 1784584435,
	data: [{ b64_json: data }],
	output_format: "png",
	background: "opaque",
	usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
});
const imageResponse = () => response(imagePayload());
const invalidResult = (error: unknown) =>
	error instanceof ImageError && error.code === "image-result-invalid";

test("official fixed Muse request uses only MODEL_API_KEY and returns a validated PNG", async () => {
	let calls = 0;
	const provider = createMuseImageProvider(
		{ MODEL_API_KEY: "  controlled-secret  " },
		async (url, options) => {
			calls++;
			assert.equal(url, "https://api.meta.ai/v1/images/generations");
			assert.equal(options?.method, "POST");
			assert.equal(options?.redirect, "error");
			assert.ok(options?.signal instanceof AbortSignal);
			assert.deepEqual(options?.headers, {
				"Content-Type": "application/json",
				Authorization: "Bearer controlled-secret",
			});
			assert.deepEqual(JSON.parse(String(options?.body)), {
				model: "muse-image-1.0",
				prompt: input.prompt,
				n: 1,
				response_format: "b64_json",
				output_format: "png",
			});
			return imageResponse();
		}
	);
	assert.equal(provider.provider, "meta");
	assert.equal(provider.model, "muse-image-1.0");
	assert.equal(MUSE_IMAGE_MODEL, "muse-image-1.0");
	const image = await provider.generate(input.prompt, signal());
	assert.equal(image.mime, "image/png");
	assert.equal(image.width, 1);
	assert.equal(image.height, 1);
	assert.deepEqual(image.bytes, bytes);
	assert.equal(calls, 1);
});
test("legacy provider selections and keys are ignored when MODEL_API_KEY is present", async () => {
	const env = new Proxy(
		{
			MODEL_API_KEY: "existing-model-key",
			IMAGE_PROVIDER: "gemini",
			GEMINI_API_KEY: "legacy-secret",
		},
		{
			get(target, name, receiver) {
				assert.equal(name, "MODEL_API_KEY");
				return Reflect.get(target, name, receiver);
			},
		}
	);
	let calls = 0;
	const provider = createMuseImageProvider(env, async (url, options) => {
		calls++;
		assert.equal(url, "https://api.meta.ai/v1/images/generations");
		assert.deepEqual(options?.headers, {
			"Content-Type": "application/json",
			Authorization: "Bearer existing-model-key",
		});
		assert.ok(!JSON.stringify(options).includes("legacy-secret"));
		return imageResponse();
	});
	await provider.generate(input.prompt, signal());
	assert.equal(calls, 1);
});
test("missing MODEL_API_KEY including legacy-only env is isolated and never calls a provider", async () => {
	let calls = 0;
	for (const env of [
		{},
		{ GEMINI_API_KEY: "controlled" },
		{ IMAGE_PROVIDER: "gemini", GEMINI_API_KEY: "controlled" },
		{ IMAGE_PROVIDER: "meta", META_API_KEY: "controlled" },
		{ IMAGE_PROVIDER: "gemini" },
		{ MODEL_API_KEY: "  ", GEMINI_API_KEY: "controlled" },
		{ MODEL_API_KEY: "x".repeat(4097) },
	]) {
		const provider = createMuseImageProvider(env, async () => {
			calls++;
			return imageResponse();
		});
		await assert.rejects(
			provider.generate(input.prompt, signal()),
			(error: unknown) => error instanceof ImageError && error.code === "image-not-configured"
		);
	}
	assert.equal(calls, 0);
});
test("invalid, URL-only, multiple, mismatched and truncated image results never report success or download", async () => {
	const base64 = bytes.toString("base64");
	const corrupt = Buffer.from(bytes);
	corrupt[40] = (corrupt[40] ?? 0) ^ 1;
	const cases = [
		null,
		{},
		{ data: [], output_format: "png" },
		{ data: [{ url: "https://example.com/image.png" }], output_format: "png" },
		{ data: [{ b64_json: base64, url: "https://example.com/image.png" }], output_format: "png" },
		{ data: [{ b64_json: base64 }, { b64_json: base64 }], output_format: "png" },
		{ data: [{ b64_json: base64 }] },
		{ ...imagePayload(), output_format: "jpeg" },
		{ ...imagePayload(), output_format: "webp" },
		{ ...imagePayload(), output_format: "PNG" },
		imagePayload(""),
		imagePayload("not base64"),
		imagePayload(`data:image/png;base64,${base64}`),
		imagePayload(`${base64}\n`),
		imagePayload(base64.slice(0, -1)),
		imagePayload("Zh=="), // Noncanonical pad bits.
		imagePayload(Buffer.from("<svg>not raster</svg>").toString("base64")),
		imagePayload(Buffer.from([0xff, 0xd8, ...new Uint8Array(24), 0xff, 0xd9]).toString("base64")),
		imagePayload(corrupt.toString("base64")),
		imagePayload(bytes.subarray(0, -12).toString("base64")),
		imagePayload(png(4097).toString("base64")),
	];
	for (const result of cases) {
		let calls = 0;
		const provider = createMuseImageProvider({ MODEL_API_KEY: "secret" }, async () => {
			calls++;
			return response(result);
		});
		await assert.rejects(provider.generate(input.prompt, signal()), invalidResult);
		assert.equal(calls, 1);
	}
});
test("invalid JSON, UTF-8 and oversized declared, streamed or base64 responses reject and cancel reads", async () => {
	for (const body of [
		'{"data":[{"b64_json":"truncated',
		Buffer.from([0xff]),
		JSON.stringify(imagePayload("A".repeat(16 * 1024 * 1024 + 4))),
	]) {
		const provider = createMuseImageProvider(
			{ MODEL_API_KEY: "secret" },
			async () => new Response(body)
		);
		await assert.rejects(provider.generate(input.prompt, signal()), invalidResult);
	}
	for (const advertised of [false, true]) {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				if (!advertised) controller.enqueue(new Uint8Array(18 * 1024 * 1024 + 1));
			},
			cancel() {
				cancelled = true;
			},
		});
		const provider = createMuseImageProvider(
			{ MODEL_API_KEY: "secret" },
			async () =>
				new Response(
					stream,
					advertised ? { headers: { "content-length": String(19 * 1024 * 1024) } } : {}
				)
		);
		await assert.rejects(provider.generate(input.prompt, signal()), invalidResult);
		assert.equal(cancelled, true);
	}
});
test("HTTP failure or redirect never retries or falls back and never exposes provider bodies", async () => {
	for (const status of [302, 401, 429, 500]) {
		let calls = 0;
		const provider = createMuseImageProvider(
			{ MODEL_API_KEY: "secret", IMAGE_PROVIDER: "gemini", GEMINI_API_KEY: "legacy" },
			async () => {
				calls++;
				return new Response("secret provider detail", {
					status,
					headers: { location: "https://example.com" },
				});
			}
		);
		await assert.rejects(
			provider.generate(input.prompt, signal()),
			(error: unknown) =>
				error instanceof ImageError &&
				error.code === "image-generation-failed" &&
				!error.message.includes("secret")
		);
		assert.equal(calls, 1);
	}
});
test("cancellation before and during transport rejects late results without reading them", async () => {
	const entered = deferred<void>();
	const result = deferred<Response>();
	let calls = 0;
	let requestSignal: AbortSignal | null | undefined;
	const provider = createMuseImageProvider(
		{ MODEL_API_KEY: "controlled" },
		async (_url, options) => {
			calls++;
			requestSignal = options?.signal;
			entered.resolve();
			return result.promise;
		}
	);
	const before = new AbortController();
	before.abort();
	await assert.rejects(provider.generate(input.prompt, before.signal), /cancelled/);
	assert.equal(calls, 0);
	const abort = new AbortController();
	const pending = provider.generate(input.prompt, abort.signal);
	await entered.promise;
	abort.abort();
	await assert.rejects(pending, /cancelled/);
	assert.equal(requestSignal?.aborted, true);
	const late = imageResponse();
	result.resolve(late);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(late.bodyUsed, false);
	assert.equal(calls, 1);
});
test("raster validation checks actual dimensions, complete pixels, checksums and refuses nonraster data", () => {
	assert.throws(() => inspectRaster(Buffer.from("<svg>not a raster image</svg>"), "image/png"));
	const corrupt = Buffer.from(bytes);
	corrupt[40] = (corrupt[40] ?? 0) ^ 1;
	assert.throws(() => inspectRaster(corrupt, "image/png"), /checksum/);
	assert.throws(
		() => inspectRaster(Buffer.concat([bytes, Buffer.from("extra")]), "image/png"),
		/Incomplete/
	);
	assert.throws(() => inspectRaster(png(4097), "image/png"), /dimensions/);
	assert.throws(() => inspectRaster(bytes, "image/jpeg"), /JPEG/);
});
test("actual private files survive reopen, preserve bytes and deduplicate same request without another generation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "muse-image-unit-"));
	try {
		let generations = 0;
		const provider = {
			provider: "controlled-test-transport",
			model: "controlled-png",
			generate: async () => {
				generations++;
				return raster();
			},
		};
		const service = new ImageService(provider, new PrivateImageStore(directory));
		const [a, b] = await Promise.all([
			service.generate(input, signal()),
			service.generate(input, signal()),
		]);
		assert.deepEqual(a, b);
		assert.equal(generations, 1);
		const result = await service.read(a.id);
		assert.equal(result.dataUrl, `data:image/png;base64,${bytes.toString("base64")}`);
		assert.equal(a.sha256, createHash("sha256").update(bytes).digest("hex"));
		assert.equal((await lstat(directory)).mode & 0o777, 0o700);
		assert.equal((await lstat(join(directory, `${a.id}.png`))).mode & 0o777, 0o600);
		const reopened = new ImageService(provider, new PrivateImageStore(directory));
		assert.deepEqual(await reopened.generate(input, signal()), a);
		assert.equal(generations, 1);
		assert.deepEqual((await reopened.read(a.id)).asset, a);
		assert.throws(
			() => service.generate({ ...input, prompt: "changed" }, signal()),
			/already used/
		);
		await writeFile(join(directory, `${a.id}.png`), Buffer.concat([bytes, Buffer.from("tamper")]));
		await assert.rejects(reopened.read(a.id), /unavailable/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("Muse metadata persists and existing legacy assets remain readable without any provider key", async () => {
	const directory = await mkdtemp(join(tmpdir(), "muse-image-unit-"));
	try {
		const legacy = new ImageService(
			{ provider: "gemini", model: "gemini-2.5-flash-image", generate: async () => raster() },
			new PrivateImageStore(directory)
		);
		const oldAsset = await legacy.generate(input, signal());
		let calls = 0;
		const muse = new ImageService(
			createMuseImageProvider({ MODEL_API_KEY: "controlled" }, async () => {
				calls++;
				return imageResponse();
			}),
			new PrivateImageStore(directory)
		);
		const newInput = { ...input, requestId: "muse-request" };
		const asset = await muse.generate(newInput, signal());
		assert.equal(asset.provider, "meta");
		assert.equal(asset.model, "muse-image-1.0");
		const reopened = new ImageService(
			createMuseImageProvider({ IMAGE_PROVIDER: "gemini", GEMINI_API_KEY: "unused" }, async () => {
				throw new Error("Saved asset reads must not use a provider");
			}),
			new PrivateImageStore(directory)
		);
		assert.deepEqual((await reopened.read(oldAsset.id)).asset, oldAsset);
		assert.equal(
			(await reopened.read(oldAsset.id)).dataUrl,
			`data:image/png;base64,${bytes.toString("base64")}`
		);
		assert.deepEqual((await reopened.read(asset.id)).asset, asset);
		assert.deepEqual(await reopened.generate(newInput, signal()), asset);
		await assert.rejects(reopened.generate(input, signal()), /already used/);
		assert.equal(calls, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("cancellation rejects late controlled provider result and never persists a successful asset", async () => {
	const directory = await mkdtemp(join(tmpdir(), "muse-image-unit-"));
	try {
		const pending = deferred<ReturnType<typeof raster>>();
		const entered = deferred<void>();
		const provider = {
			provider: "controlled",
			model: "controlled",
			generate: async () => {
				entered.resolve();
				return pending.promise;
			},
		};
		const service = new ImageService(provider, new PrivateImageStore(directory));
		const abort = new AbortController();
		const generating = service.generate(input, abort.signal);
		await entered.promise;
		abort.abort();
		await assert.rejects(generating, /cancelled/i);
		pending.resolve(raster());
		await new Promise((resolve) => setImmediate(resolve));
		const reopened = new ImageService(provider, new PrivateImageStore(directory));
		await assert.rejects(reopened.generate(input, signal()), /already used/);
		assert.equal((await readdir(directory)).filter((file) => file.endsWith(".png")).length, 0);
		service.cancel("before-registration");
		await assert.rejects(
			service.generate({ ...input, requestId: "before-registration" }, signal()),
			/cancelled/
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("private store rejects path traversal and symlinked binary reads", async () => {
	const directory = await mkdtemp(join(tmpdir(), "muse-image-unit-"));
	try {
		const service = new ImageService(
			{ provider: "controlled", model: "controlled", generate: async () => raster() },
			new PrivateImageStore(directory)
		);
		const asset = await service.generate(input, signal());
		await assert.rejects(service.read("../other"), /unavailable/);
		const path = join(directory, `${asset.id}.png`);
		const copied = await readFile(path);
		await rm(path);
		const outside = join(directory, "outside.png");
		await writeFile(outside, copied);
		await symlink(outside, path);
		await assert.rejects(service.read(asset.id), /unavailable/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("hanging controlled response reads cancel promptly even when stream cancellation never resolves", async () => {
	const reading = deferred<void>();
	const stream = new ReadableStream<Uint8Array>({
		pull() {
			reading.resolve();
			return new Promise<void>(() => {});
		},
		cancel() {
			return new Promise<void>(() => {});
		},
	});
	const provider = createMuseImageProvider(
		{ MODEL_API_KEY: "controlled" },
		async () => new Response(stream)
	);
	const abort = new AbortController();
	const pending = provider.generate(input.prompt, abort.signal);
	await reading.promise;
	abort.abort();
	await assert.rejects(pending, /cancelled/);
});

test("streamed response bytes and concurrent private admission are bounded", async () => {
	const oversized = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(18 * 1024 * 1024 + 1));
			controller.close();
		},
	});
	const provider = createMuseImageProvider(
		{ MODEL_API_KEY: "controlled" },
		async () => new Response(oversized)
	);
	await assert.rejects(provider.generate(input.prompt, signal()), /bounded raster/);
	const directory = await mkdtemp(join(tmpdir(), "muse-image-unit-"));
	try {
		const store = new PrivateImageStore(directory, 1);
		const outcomes = await Promise.allSettled([
			store.admit("one", "a".repeat(64), signal()),
			store.admit("two", "b".repeat(64), signal()),
		]);
		assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
		assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
		assert.equal((await readdir(directory)).filter((file) => file.endsWith(".json")).length, 1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
