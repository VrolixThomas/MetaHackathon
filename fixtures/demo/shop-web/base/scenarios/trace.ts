import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function trace(id, file, anchor, label, values, outcome = "value") {
	const source = readFileSync(resolve(file), "utf8").split("\n");
	const line = source.findIndex((text) => text.includes(anchor)) + 1;
	if (line === 0) throw new Error(`Trace anchor missing: ${file}:${anchor}`);
	console.log(`METAHACKATHON_TRACE ${JSON.stringify({ id, file, line, label, values, outcome })}`);
}
