const { requireSigningCredentials } = require("./credentials.cjs");
const { existsSync } = require("node:fs");
const path = require("node:path");

module.exports = async (context) => {
	if (context.electronPlatformName !== "darwin") return;
	if (context.packager.config.forceCodeSigning === false) {
		if (process.env.METAHACKATHON_UNSIGNED_LOCAL !== "1") {
			throw new Error(
				"Unsigned packaging requires METAHACKATHON_UNSIGNED_LOCAL=1 and the unsigned config"
			);
		}
		console.warn("LOCAL PROBE: this artifact has no Developer ID signature or notarization.");
		return;
	}
	requireSigningCredentials();
	if (!existsSync(path.resolve(context.packager.projectDir, "../../fixtures/demo"))) {
		throw new Error("Signed release blocked: fixtures/demo is missing from packaged resources");
	}
};
