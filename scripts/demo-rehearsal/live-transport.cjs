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
				const rootSchema = schemas.get(item.name) ?? {};
				const properties = [];
				const type = (value) =>
					value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
				const walk = (value, rawSchema, path = [], depth = 0) => {
					if (depth > 7 || properties.length >= 80) return;
					let schema = rawSchema ?? {};
					if (schema.$ref?.startsWith("#/$defs/"))
						schema = rootSchema.$defs?.[schema.$ref.slice(8)] ?? {};
					const choices = schema.anyOf ?? schema.oneOf;
					if (choices)
						schema =
							choices.find(
								(choice) =>
									choice.properties?.kind?.const === value?.kind && value?.kind !== undefined
							) ??
							choices.find((choice) => choice.type === type(value)) ??
							choices[0];
					if (path.length)
						properties.push({
							name: path.join("."),
							type: type(value),
							...(schema.enum ? { enumValid: schema.enum.includes(value) } : {}),
							...(schema.format === "date-time"
								? {
										formatValid:
											typeof value === "string" &&
											/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
											Number.isFinite(Date.parse(value)),
									}
								: {}),
						});
					if (Array.isArray(value))
						for (let i = 0; i < Math.min(value.length, 8); i++)
							walk(value[i], schema.items, [...path, i], depth + 1);
					else if (value && typeof value === "object") {
						for (const key of schema.required ?? [])
							if (!(key in value))
								properties.push({ name: [...path, key].join("."), type: "missing-required" });
						for (const key of Object.keys(value)) {
							if (schema.properties?.[key])
								walk(value[key], schema.properties[key], [...path, key], depth + 1);
							else
								properties.push({
									name: [...path, "unexpected-property"].join("."),
									type: type(value[key]),
								});
						}
					}
				};
				walk(args, rootSchema);
				return { validJSON: true, properties: properties.slice(0, 80) };
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
		if (!response.ok) {
			const error = await response
				.clone()
				.json()
				.catch(() => null);
			// Fixed diagnostic categories only; never retain provider message/source text.
			const details = error?.error;
			emit({
				kind: "model-error",
				id,
				status: response.status,
				code:
					typeof details?.code === "string" && /^[a-z_]{1,80}$/i.test(details.code)
						? details.code
						: null,
				parameter:
					typeof details?.param === "string" && /^[a-z0-9_.\[\]]{1,120}$/i.test(details.param)
						? details.param
						: null,
				callIdTooLong:
					/call_id|call id/i.test(String(details?.message)) &&
					/length|long|64/i.test(String(details?.message)),
			});
			return response;
		}
		if (!response.body) return response;
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
