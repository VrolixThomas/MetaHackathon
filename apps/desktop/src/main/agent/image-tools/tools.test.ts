import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ConversationTurnInput,
	type ImageAsset,
	WorkspaceObservationSchema,
} from "../../../shared/contracts";
import { ConversationWorkspaceTools } from "../workspace-tools";
import { ConversationImageTools } from "./index";

const turn: ConversationTurnInput = {
	sessionId: "session",
	turnId: "turn",
	generation: 1,
	requestId: "request",
	text: "Generate a painting",
};
const asset: ImageAsset = {
	id: "actual-private-asset",
	title: "Painting",
	mime: "image/png",
	sha256: "a".repeat(64),
	width: 1024,
	height: 1024,
	byteLength: 1000,
	createdAt: "2026-11-01T00:00:00Z",
	provenance: "provider-generated",
	provider: "controlled-test-transport",
	model: "controlled",
};
function observation(image?: ImageAsset, displayed = true) {
	return WorkspaceObservationSchema.parse({
		workspace: {
			sequence: image ? 1 : 0,
			canvases: [
				{ id: "home", title: "Home", revision: 1, kind: "center", section: "home" },
				...(image
					? [{ id: "image-canvas", title: image.title, revision: 1, kind: "image", asset: image }]
					: []),
			],
			primaryId: image && displayed ? "image-canvas" : "home",
			secondaryId: null,
			review: { sequence: 0, mode: "conversation", prId: null },
			codeView: "diff",
			browser: null,
		},
		browser: null,
		reviews: [],
		capabilities: ["images", "documents", "visuals"],
		savedCanvases: [],
	});
}
test("real raster generation uses a unique app request and waits for matching visible acknowledged image metadata", async () => {
	const ids = new Set<string>();
	let shown = 0;
	const tools = new ConversationImageTools(
		{
			generate: async (input) => {
				assert.equal(ids.has(input.requestId), false);
				ids.add(input.requestId);
				assert.equal(input.prompt, "A painting");
				return asset;
			},
			cancel: () => {},
		},
		turn,
		new AbortController().signal,
		async (id, target) => {
			assert.equal(id, asset.id);
			assert.equal(target, "secondary");
			shown++;
			return observation(asset);
		}
	);
	for (let count = 0; count < 2; count++)
		assert.equal(
			(
				await tools.execute(
					"generate_raster_image",
					'{"title":"Painting","prompt":"A painting","target":"secondary"}'
				)
			).displayed,
			true
		);
	assert.equal(shown, 2);
	assert.equal(ids.size, 2);
	const changed = new ConversationImageTools(
		{ generate: async () => asset, cancel: () => {} },
		turn,
		new AbortController().signal,
		async () => observation({ ...asset, sha256: "b".repeat(64) })
	);
	await assert.rejects(
		changed.execute("generate_raster_image", '{"title":"Painting","prompt":"A painting"}'),
		/not acknowledged/
	);
	const hidden = new ConversationImageTools(
		{ generate: async () => asset, cancel: () => {} },
		turn,
		new AbortController().signal,
		async () => observation(asset, false)
	);
	await assert.rejects(
		hidden.execute("generate_raster_image", '{"title":"Painting","prompt":"A painting"}'),
		/not acknowledged/
	);
});
test("malformed arguments and provider failures produce no workspace effect; abort cancels exact request and discards late image", async () => {
	let generated = 0;
	let shown = 0;
	let cancelled = "";
	let cancellationCalls = 0;
	let resolve!: (image: ImageAsset) => void;
	const pending = new Promise<ImageAsset>((yes) => {
		resolve = yes;
	});
	const abort = new AbortController();
	const tools = new ConversationImageTools(
		{
			generate: async (input) => {
				generated++;
				cancelled = input.requestId;
				return pending;
			},
			cancel: (id) => {
				cancellationCalls++;
				assert.equal(id, cancelled);
			},
		},
		turn,
		abort.signal,
		async () => {
			shown++;
			return observation(asset);
		}
	);
	await assert.rejects(
		tools.execute(
			"generate_raster_image",
			'{"title":"Painting","prompt":"A painting","url":"https://example.com/a.png"}'
		)
	);
	assert.equal(generated, 0);
	const work = tools.execute("generate_raster_image", '{"title":"Painting","prompt":"A painting"}');
	abort.abort();
	await assert.rejects(work, /cancelled/);
	assert.equal(cancellationCalls, 1);
	resolve(asset);
	assert.equal(shown, 0);
	const missing = new ConversationImageTools(
		{
			generate: async () => {
				throw new Error("Image provider not configured");
			},
			cancel: () => {},
		},
		turn,
		new AbortController().signal,
		async () => {
			shown++;
			return observation(asset);
		}
	);
	await assert.rejects(
		missing.execute("generate_raster_image", '{"title":"Painting","prompt":"A painting"}'),
		/not configured/
	);
	assert.equal(shown, 0);
});
test("workspace image tool shares existing effect identity/receipt path and existing typed SVG tools remain available", async () => {
	let current = observation();
	const actions: string[] = [];
	const tools = new ConversationWorkspaceTools(
		{
			images: { generate: async () => asset, cancel: () => {} },
			observe: async () => current,
			execute: async (command, identity, _signal, onAction) => {
				assert.equal(command.kind, "show-image");
				const previous = current;
				current = observation(asset);
				onAction({
					kind: "workspace-canvas",
					screenSequence: previous.workspace.review.sequence,
					...identity,
					effect: { expectedSequence: previous.workspace.sequence, snapshot: current.workspace },
				});
				return current;
			},
		},
		turn,
		new AbortController().signal,
		(action) => actions.push(action.requestId)
	);
	await tools.observe();
	assert.ok(tools.tools.some((tool) => tool.name === "create_visual_mock"));
	assert.ok(tools.tools.some((tool) => tool.name === "generate_raster_image"));
	const result = await tools.execute(
		"generate_raster_image",
		'{"title":"Painting","prompt":"A painting"}'
	);
	assert.equal(result.workspace.primaryId, "image-canvas");
	assert.equal(actions.length, 1);
	const absent = new ConversationWorkspaceTools(
		{ observe: async () => observation(), execute: async () => observation() },
		turn,
		new AbortController().signal,
		() => {}
	);
	assert.equal(
		absent.tools.some((tool) => tool.name === "generate_raster_image"),
		false
	);
});

test("show-image admission uses observed asset identity and closed images reopen through actual Recent canvas IDs", async () => {
	let current = observation(asset);
	let operations = 0;
	current.savedCanvases = [
		{ id: "closed-image-canvas", title: "Saved painting", revision: 1, kind: "image" },
	];
	const tools = new ConversationWorkspaceTools(
		{
			observe: async () => current,
			execute: async (_command, identity, _signal, onAction) => {
				operations++;
				const previous = current.workspace.sequence;
				current = structuredClone(current);
				current.workspace.sequence++;
				onAction({
					kind: "workspace-canvas",
					...identity,
					screenSequence: current.workspace.review.sequence,
					effect: { expectedSequence: previous, snapshot: current.workspace },
				});
				return current;
			},
		},
		turn,
		new AbortController().signal,
		() => {}
	);
	await tools.observe();
	await assert.rejects(
		tools.execute("show_generated_image", '{"assetId":"invented"}'),
		/observed raster/
	);
	assert.equal(operations, 0);
	await tools.execute(
		"show_generated_image",
		JSON.stringify({ assetId: asset.id, target: "secondary" })
	);
	assert.equal(operations, 1);
	await tools.execute("focus_canvas", '{"id":"closed-image-canvas"}');
	assert.equal(operations, 2);
});
