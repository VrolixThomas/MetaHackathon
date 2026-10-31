// A deliberately unsupported, test-only executable. Never opens vendor auth or a model session.
const readline = require("node:readline");
const { append } = require("./control.cjs");
function frame(input) {
	if (input.id === undefined) return null;
	if (input.method === "initialize")
		return {
			id: input.id,
			result: {
				serverInfo: { name: "CONTROLLED unsupported CLI", version: "0.0.0" },
				capabilities: {},
			},
		};
	return { id: input.id, error: { code: -32601, message: "CONTROLLED unsupported method" } };
}
function main(audit) {
	const argv = process.argv.slice(2);
	append(audit, {
		type: "fake-cli",
		versionOnly: argv.includes("--version"),
		leakedKeys: Object.keys(process.env).filter((key) =>
			/TOKEN|SECRET|API_KEY|NODE_OPTIONS/.test(key)
		),
	});
	if (argv.includes("--version")) {
		console.log("muse 1.4.13");
		return;
	}
	const timer = setTimeout(() => process.exit(72), 7000);
	const input = readline.createInterface({ input: process.stdin });
	input.on("line", (line) => {
		try {
			const packet = JSON.parse(line);
			append(audit, { type: "fake-cli-method", method: packet.method ?? null });
			const output = frame(packet);
			if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
		} catch {
			process.exitCode = 72;
			input.close();
		}
	});
	input.on("close", () => {
		clearTimeout(timer);
	});
}
module.exports = { frame, main };
