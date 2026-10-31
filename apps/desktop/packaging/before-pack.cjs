const { requireSigningCredentials } = require("./credentials.cjs");
const path = require("node:path");
const { verifyVoiceBundle, targetArchitectures } = require("./payload.cjs");

module.exports = async (context) => {
	if (context.electronPlatformName !== "darwin") return;
	if (context.packager.config.forceCodeSigning === false) {
		if (process.env.METAHACKATHON_UNSIGNED_LOCAL !== "1") {
			throw new Error(
				"Unsigned packaging requires METAHACKATHON_UNSIGNED_LOCAL=1 and the unsigned config"
			);
		}
		console.warn("LOCAL PROBE: this artifact has no Developer ID signature or notarization.");
	} else {
		requireSigningCredentials();
	}
	// The explicitly separate generated hello-world probe omits product payloads.
	if (context.packager.config.extraResources !== null) {
		verifyVoiceBundle(
			path.resolve(context.packager.projectDir, "../../services/voice/dist/metahackathon-voice"),
			targetArchitectures(context.arch)
		);
	}
};
