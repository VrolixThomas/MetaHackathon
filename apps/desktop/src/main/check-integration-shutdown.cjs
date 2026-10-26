const assert = require("node:assert/strict");
const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const net = require("node:net");
const path = join(__dirname, "../../out/integration-smoke-report.json");
const report = JSON.parse(readFileSync(path, "utf8"));
const socket = net.createConnection({ host: "127.0.0.1", port: report.preview.shutdownPort });
socket.setTimeout(1000);
socket.once("connect", () => {
	socket.destroy();
	throw new Error("Preview port survived app shutdown");
});
socket.once("timeout", () => {
	socket.destroy();
	throw new Error("Could not verify shutdown port");
});
socket.once("error", (error) => {
	assert.equal(error.code, "ECONNREFUSED");
	assert.deepEqual(readdirSync(join(report.userData, "runtime", "demo")), []);
	report.shutdown = { previewPortClosed: true, seedRepositoriesRemoved: true };
	writeFileSync(path, JSON.stringify(report, null, 2));
	console.log(
		"SHUTDOWN_PASS: app quit stopped its remaining preview and removed owned seeded repositories"
	);
});
