// Never print secret values or pass them to a renderer.
function requireSigningCredentials(env = process.env) {
	const required = [
		"CSC_LINK",
		"CSC_KEY_PASSWORD",
		"APPLE_ID",
		"APPLE_APP_SPECIFIC_PASSWORD",
		"APPLE_TEAM_ID",
	];
	const missing = required.filter((name) => !env[name]);
	if (missing.length) {
		throw new Error(`Signed release blocked: missing CI secrets ${missing.join(", ")}`);
	}
	if (env.CSC_IDENTITY_AUTO_DISCOVERY === "false") {
		throw new Error("Signed release blocked: CSC_IDENTITY_AUTO_DISCOVERY must not be false");
	}
}

module.exports = { requireSigningCredentials };
if (require.main === module) requireSigningCredentials();
