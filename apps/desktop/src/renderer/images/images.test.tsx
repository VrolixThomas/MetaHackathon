import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ImageAsset } from "../../shared/contracts";
import { ImageCanvas } from "./ImageCanvas";
import { loadImageAsset, waitForImagePresentation } from "./controller";

// Controlled decoder/controller probes only; native browser decode is a root acceptance check.
const bytes = Buffer.from("controlled image bytes");
const asset: ImageAsset = {
	id: "controlled-asset",
	title: "<Unsafe title>",
	mime: "image/png",
	width: 1,
	height: 1,
	sha256: createHash("sha256").update(bytes).digest("hex"),
	byteLength: bytes.length,
	createdAt: "2026-11-01T00:00:00Z",
	provenance: "provider-generated",
	provider: "controlled-test-transport",
	model: "controlled",
};
const result = { asset, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
const signal = () => new AbortController().signal;
test("renderer reads only an asset ID, checks exact persisted metadata, MIME, byte count and digest", async () => {
	assert.deepEqual(
		await loadImageAsset(
			asset,
			async (id) => {
				assert.equal(id, asset.id);
				return result;
			},
			signal()
		),
		result
	);
	for (const changed of [
		{ ...result, asset: { ...asset, sha256: "a".repeat(64) } },
		{ ...result, dataUrl: result.dataUrl.replace("png", "jpeg") },
		{ ...result, dataUrl: "https://example.com/image.png" },
		{
			...result,
			dataUrl: `data:image/png;base64,${Buffer.from("same length but altered").toString("base64")}`,
		},
	]) {
		await assert.rejects(loadImageAsset(asset, async () => changed, signal()));
	}
	const altered = Buffer.from(bytes);
	altered[0] = 0;
	await assert.rejects(
		loadImageAsset(
			asset,
			async () => ({ ...result, dataUrl: `data:image/png;base64,${altered.toString("base64")}` }),
			signal()
		),
		/digest/
	);
	const abort = new AbortController();
	abort.abort();
	let calls = 0;
	await assert.rejects(
		loadImageAsset(
			asset,
			async () => {
				calls++;
				return result;
			},
			abort.signal
		),
		/cancelled/
	);
	assert.equal(calls, 0);
});
test("renderer never acknowledges before decode plus two visible frames at exact natural dimensions", async () => {
	let decoded = false;
	let frames = 0;
	const image = {
		decode: async () => {
			decoded = true;
		},
		complete: true,
		naturalWidth: 1,
		naturalHeight: 1,
		getClientRects: () => ({ length: 1 }) as DOMRectList,
	};
	assert.equal(
		await waitForImagePresentation(
			image,
			asset,
			signal(),
			async () => {
				assert.equal(decoded, true);
				frames++;
			},
			() => true
		),
		true
	);
	assert.equal(frames, 2);
	assert.equal(
		await waitForImagePresentation(
			{ ...image, naturalWidth: 2 },
			asset,
			signal(),
			async () => {},
			() => true
		),
		false
	);
	assert.equal(
		await waitForImagePresentation(
			{
				...image,
				decode: async () => {
					throw new Error("controlled decode failure");
				},
			},
			asset,
			signal(),
			async () => {},
			() => true
		),
		false
	);
	assert.equal(
		await waitForImagePresentation(
			image,
			asset,
			signal(),
			async () => {},
			() => false
		),
		false
	);
	const abort = new AbortController();
	frames = 0;
	assert.equal(
		await waitForImagePresentation(
			image,
			asset,
			abort.signal,
			async () => {
				frames++;
				abort.abort();
			},
			() => true
		),
		false
	);
	assert.equal(frames, 1);
});
test("image markup starts loading without a positive source marker or an arbitrary external URL", () => {
	let reads = 0;
	const html = renderToStaticMarkup(
		createElement(ImageCanvas, {
			asset,
			read: async () => {
				reads++;
				return result;
			},
		})
	);
	assert.equal(reads, 0);
	assert.ok(html.includes('data-image-ready="false"'));
	assert.equal(html.includes("data-image-asset-id"), false);
	assert.equal(html.includes("<img"), false);
	assert.ok(html.includes("&lt;Unsafe title&gt;"));
	assert.equal(html.includes("https://"), false);
});
