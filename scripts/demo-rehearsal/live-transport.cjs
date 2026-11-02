// Transparent live Meta transport tap. No credentials, reasoning, inputs or raw arguments.
const { randomUUID } = require("node:crypto");
const { appendFileSync } = require("node:fs");
function instrumentModels(forward, emit, context = () => null, limit = 120) {
	let count = 0;
	return async (input, init = {}) => {
		const address = String(input.url ?? input);
		if (address !== "https://api.meta.ai/v1/responses") throw Error("Unapproved live endpoint");
		if (++count > limit) throw Error("Rehearsal model-call budget exceeded");
		const body = JSON.parse(init.body);
		const names = new Set((body.tools ?? []).map((tool) => tool.name));
		const schemas = new Map((body.tools ?? []).map((tool) => [tool.name, tool.parameters]));
		const argumentShape = (item) => {
			try {
				const args = JSON.parse(item.arguments);
				const properties = schemas.get(item.name)?.properties ?? {};
				return {
					validJSON: true,
					properties: Object.keys(args).map((key) => {
						const schema = properties[key];
						return {
							name: schema ? key : "unexpected-property",
							type: Array.isArray(args[key]) ? "array" : typeof args[key],
							...(schema?.enum
								? { enumValue: schema.enum.includes(args[key]) ? args[key] : "invalid-enum" }
								: {}),
						};
					}),
				};
			} catch {
				return { validJSON: false };
			}
		};
		const id = randomUUID();
		const ctx = context();
		emit({
			kind: "model-request",
			id,
			at: Date.now(),
			context: ctx,
			model: body.model,
			reasoning: body.reasoning?.effort,
			inputBytes: Buffer.byteLength(JSON.stringify(body.input)),
			toolCount: names.size,
			offeredTools: [...names],
			toolBytes: Buffer.byteLength(JSON.stringify(body.tools ?? [])),
		});
		const response = await forward(input, init);
		emit({ kind: "model-headers", id, at: Date.now(), status: response.status });
		if (!response.ok || !response.body) return response;
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		let first = false;
		const inspect = (line) => {
			if (!line.startsWith("data:")) return;
			let event;
			try {
				event = JSON.parse(line.slice(5).trim());
			} catch {
				return;
			}
			if (event.type === "response.output_text.delta" && !first) {
				first = true;
				emit({ kind: "model-first-text", id, at: Date.now() });
			}
			if (event.type === "response.completed" || event.type === "response.incomplete") {
				const output = event.response?.output ?? [];
				emit({
					kind: "model-terminal",
					id,
					at: Date.now(),
					status: event.response?.status,
					model: event.response?.model,
					inputTokens: event.response?.usage?.input_tokens ?? null,
					outputTokens: event.response?.usage?.output_tokens ?? null,
					tools: output
						.filter((item) => item.type === "function_call")
						.map((item) => (names.has(item.name) ? item.name : "unexpected-tool")),
					argumentShapes: output
						.filter((item) => item.type === "function_call" && names.has(item.name))
						.map(argumentShape),
				});
			}
		};
		return new Response(
			new ReadableStream({
				async pull(controller) {
					try {
						const part = await reader.read();
						if (part.done) {
							controller.close();
							return;
						}
						controller.enqueue(part.value);
						pending += decoder.decode(part.value, { stream: true });
						if (pending.length > 2_000_000) pending = "";
						let index = pending.indexOf("\n");
						while (index >= 0) {
							inspect(pending.slice(0, index));
							pending = pending.slice(index + 1);
							index = pending.indexOf("\n");
						}
					} catch (error) {
						emit({
							kind: "model-stream-ended",
							id,
							at: Date.now(),
							cancelled: !!init.signal?.aborted,
						});
						controller.error(error);
					}
				},
				cancel(reason) {
					return reader.cancel(reason);
				},
			}),
			{ status: response.status, headers: response.headers }
		);
	};
}
function childHook(logPath) {
	const original = globalThis.fetch;
	globalThis.fetch = instrumentModels(original, (row) =>
		appendFileSync(logPath, `${JSON.stringify(row)}\n`)
	);
}
module.exports = { instrumentModels, childHook };
