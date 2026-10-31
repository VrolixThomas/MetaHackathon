import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { ImageService, PrivateImageStore, createGeminiImageProvider } from "./index";
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
const imageResponse = () =>
	response({
		candidates: [
			{
				finishReason: "STOP",
				content: {
					parts: [{ inlineData: { mimeType: "image/png", data: bytes.toString("base64") } }],
				},
			},
		],
	});

test("official fixed Gemini request returns only an actual supported inline raster", async () => {
	let calls = 0;
	const provider = createGeminiImageProvider(
		{ IMAGE_PROVIDER: "gemini", GEMINI_API_KEY: "controlled-secret" },
		async (url, options) => {
			calls++;
			assert.equal(
				url,
				"https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-image:generateContent"
			);
			assert.equal(options?.redirect, "error");
			assert.deepEqual(options?.headers, {
				"Content-Type": "application/json",
				"x-goog-api-key": "controlled-secret",
			});
			assert.deepEqual(JSON.parse(String(options?.body)).contents, [
				{ role: "user", parts: [{ text: input.prompt }] },
			]);
			return imageResponse();
		}
	);
	const image = await provider.generate(input.prompt, signal());
	assert.equal(image.width, 1);
	assert.equal(image.height, 1);
	assert.deepEqual(image.bytes, bytes);
	assert.equal(calls, 1);
});
test("missing explicit image configuration is isolated and never calls any provider", async () => {
	let calls = 0;
	for (const env of [
		{},
		{ GEMINI_API_KEY: "controlled" },
		{ IMAGE_PROVIDER: "meta", META_API_KEY: "controlled" },
		{ IMAGE_PROVIDER: "gemini" },
	]) {
		const provider = createGeminiImageProvider(env, async () => {
			calls++;
			return imageResponse();
		});
		await assert.rejects(provider.generate(input.prompt, signal()), /Configure IMAGE_PROVIDER/);
	}
	assert.equal(calls, 0);
});
test("remote URLs, malformed/MIME-mismatched images, refusal and unbounded results never report success", async () => {
	const cases = [
		{
			candidates: [
				{ content: { parts: [{ fileData: { fileUri: "https://example.com/image.png" } }] } },
			],
		},
		{
			candidates: [
				{ content: { parts: [{ inlineData: { mimeType: "image/svg+xml", data: "PHN2Zy8+" } }] } },
			],
		},
		{ candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "blocked" }] } }] },
		{
			candidates: [
				{
					content: {
						parts: [{ inlineData: { mimeType: "image/jpeg", data: bytes.toString("base64") } }],
					},
				},
			],
		},
		{
			candidates: [
				{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "not base64" } }] } },
			],
		},
	];
	for (const result of cases) {
		const provider = createGeminiImageProvider(
			{ IMAGE_PROVIDER: "gemini", GEMINI_API_KEY: "secret" },
			async () => response(result)
		);
		await assert.rejects(
			provider.generate(input.prompt, signal()),
			(error: Error) => !error.message.includes("secret") && /image/i.test(error.message)
		);
	}
	const large = createGeminiImageProvider(
		{ IMAGE_PROVIDER: "gemini", GEMINI_API_KEY: "secret" },
		async () => new Response("{}", { headers: { "content-length": String(19 * 1024 * 1024) } })
	);
	await assert.rejects(large.generate(input.prompt, signal()), /bounded raster/);
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
	const provider = createGeminiImageProvider(
		{ IMAGE_PROVIDER: "gemini", GEMINI_API_KEY: "controlled" },
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
	const provider = createGeminiImageProvider(
		{ IMAGE_PROVIDER: "gemini", GEMINI_API_KEY: "controlled" },
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
