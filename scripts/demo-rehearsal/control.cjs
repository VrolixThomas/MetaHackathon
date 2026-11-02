#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const active = JSON.parse(
	readFileSync(resolve(__dirname, "../../apps/desktop/out/demo-rehearsal/active.json"), "utf8")
);
const [command = "status", ...words] = process.argv.slice(2);
const body = command === "say" ? { command, text: words.join(" ") } : { command };
fetch(`http://127.0.0.1:${active.port}/control`, {
	method: "POST",
	headers: { "content-type": "application/json", "x-rehearsal-control": active.token },
	body: JSON.stringify(body),
})
	.then(async (response) => {
		console.log(JSON.stringify(await response.json(), null, 2));
		if (!response.ok) process.exitCode = 1;
	})
	.catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
