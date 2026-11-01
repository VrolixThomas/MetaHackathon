const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { deflateSync, inflateSync } = require("node:zlib");
const MODEL_URL = "https://api.meta.ai/v1/responses";
const IMAGE_URL = "https://api.meta.ai/v1/images/generations";
const TITLE = "CONTROLLED_IMAGE_SMOKE";
function crc(bytes) {
	let value = 0xffffffff;
	for (const byte of bytes) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
	}
	return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const payload = Buffer.concat([Buffer.from(type), data]);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc(payload));
	return Buffer.concat([length, payload, checksum]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(2, 0);
header.writeUInt32BE(2, 4);
header[8] = 8;
header[9] = 2;
const pixels = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
const PNG = Buffer.concat([
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
	chunk("IHDR", header),
	chunk("IDAT", deflateSync(pixels)),
	chunk("IEND", Buffer.alloc(0)),
]);
const SHA = createHash("sha256").update(PNG).digest("hex");
function imageResult(body) {
	assert.deepEqual(body, {
		model: "muse-image-1.0",
		prompt: body.prompt,
		n: 1,
		response_format: "b64_json",
		output_format: "png",
	});
	assert.equal(typeof body.prompt, "string");
	return { data: [{ b64_json: PNG.toString("base64") }], output_format: "png" };
}
function modelResult(body, serial) {
	assert.equal(body.stream, true);
	assert.equal(body.store, false);
	const lastUser = body.input.findLastIndex(
		(item) => item.role === "user" && typeof item.content === "string"
	);
	assert.ok(lastUser >= 0, "Actual renderer user turn required");
	const question = body.input[lastUser].content;
	const outputs = body.input
		.slice(lastUser + 1)
		.filter((item) => item.type === "function_call_output");
	let output;
	if (question === "Ordinary conversation after image failure")
		output = [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Ordinary conversation is still available." }],
			},
		];
	else if (!outputs.length) {
		assert.ok(
			body.tools.some((tool) => tool.name === "generate_raster_image"),
			"Actual image tool missing"
		);
		assert.ok(
			["Generate controlled image", "Generate cancelled image", "Generate denied image"].includes(
				question
			)
		);
		output = [
			{
				type: "function_call",
				name: "generate_raster_image",
				call_id: `image-${serial}`,
				arguments: JSON.stringify({ title: TITLE, prompt: question }),
				status: "completed",
			},
		];
	} else
		output = [
			{
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: question.includes("denied")
							? "Image configuration is unavailable; ordinary conversation remains available."
							: "The controlled generated image is displayed.",
					},
				],
			},
		];
	return `data: ${JSON.stringify({ type: "response.completed", response: { id: `image-smoke-${serial}`, model: body.model, status: "completed", usage: null, output } })}\n\n`;
}
const DOM = `(() => { const m=document.querySelector('main.conversation-main'), w=document.querySelector('.canvas-workspace'), x=[...document.querySelectorAll('article.exchange')].at(-1); return {sessionId:m?.dataset.sessionId,turnId:m?.dataset.turnId,generation:Number(m?.dataset.generation),phase:x?.dataset.phase,sequence:Number(w?.dataset.workspaceSequence),images:[...document.querySelectorAll('[data-image-ready="true"]')].map(e=>{const i=e.querySelector('img'),r=e.getBoundingClientRect();return {id:e.dataset.imageAssetId,sha:e.dataset.imageSha256,complete:i?.complete,width:i?.naturalWidth,height:i?.naturalHeight,visible:document.visibilityState==='visible'&&r.width>0&&r.height>0,src:i?.currentSrc};})}; })()`;
function assertFrame(frame, asset) {
	const image = frame.images.find((item) => item.id === asset.id);
	assert.ok(image, "Actual ready image DOM missing at receipt");
	assert.equal(image.sha, SHA);
	assert.equal(image.complete, true);
	assert.equal(image.width, 2);
	assert.equal(image.height, 2);
	assert.equal(image.visible, true);
	assert.equal(image.src, `data:image/png;base64,${PNG.toString("base64")}`);
}
function selfCheck() {
	assert.equal(PNG.readUInt32BE(16), 2);
	assert.equal(PNG.readUInt32BE(20), 2);
	let offset = 8;
	let decompressed;
	while (offset < PNG.length) {
		const size = PNG.readUInt32BE(offset);
		assert.equal(
			crc(PNG.subarray(offset + 4, offset + 8 + size)),
			PNG.readUInt32BE(offset + 8 + size)
		);
		if (PNG.toString("ascii", offset + 4, offset + 8) === "IDAT")
			decompressed = inflateSync(PNG.subarray(offset + 8, offset + 8 + size));
		offset += size + 12;
	}
	assert.deepEqual(decompressed, pixels);
	assert.equal(offset, PNG.length);
	assert.equal(
		imageResult({
			model: "muse-image-1.0",
			prompt: "controlled",
			n: 1,
			response_format: "b64_json",
			output_format: "png",
		}).data[0].b64_json,
		PNG.toString("base64")
	);
	const body = {
		stream: true,
		store: false,
		model: "controlled",
		input: [{ role: "user", content: "Generate controlled image" }],
		tools: [{ name: "generate_raster_image" }],
	};
	assert.ok(modelResult(body, 1).includes("function_call"));
	assert.throws(() => modelResult({ ...body, tools: [] }, 1));
	assertFrame(
		{
			images: [
				{
					id: "test",
					sha: SHA,
					complete: true,
					width: 2,
					height: 2,
					visible: true,
					src: `data:image/png;base64,${PNG.toString("base64")}`,
				},
			],
		},
		{ id: "test" }
	);
	assert.throws(() => assertFrame({ images: [] }, { id: "test" }));
	console.log(
		"IMAGE_WORKSPACE_SELF_CHECK_PASS: PNG CRC/pixels, provider protocol and receipt assertions only; NO Electron, HTTP server, network, model or microphone launched"
	);
}
module.exports = {
	MODEL_URL,
	IMAGE_URL,
	TITLE,
	PNG,
	SHA,
	imageResult,
	modelResult,
	DOM,
	assertFrame,
	selfCheck,
};
