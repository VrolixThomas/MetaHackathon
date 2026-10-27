import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

test("production worklet is a separate self-origin asset rather than a CSP-blocked data URL", async () => {
	const result = await build({
		configFile: false,
		logLevel: "silent",
		root: fileURLToPath(new URL("./", import.meta.url)),
		build: {
			write: false,
			minify: false,
			rollupOptions: {
				input: fileURLToPath(new URL("./hands-free.ts", import.meta.url)),
				preserveEntrySignatures: "strict",
			},
		},
	});
	assert.ok(!Array.isArray(result) && "output" in result);
	const asset = result.output.find(
		(item) => item.type === "asset" && item.fileName.includes("hands-free-worklet")
	);
	assert.ok(asset && asset.type === "asset");
	assert.match(String(asset.source), /registerProcessor\("voice-hands-free"/);
	const bundle = result.output
		.filter((item) => item.type === "chunk")
		.map((item) => item.code)
		.join("\n");
	assert.ok(bundle.includes(asset.fileName));
	assert.equal(bundle.includes("data:application/javascript"), false);
});
