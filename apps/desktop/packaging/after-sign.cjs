const path = require("node:path");
const { verifyApp } = require("./verify-app.cjs");

module.exports = async (context) => {
	if (context.electronPlatformName !== "darwin") return;
	const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	const result = verifyApp(appPath, process.env.APPLE_TEAM_ID);
	console.log(`Verified Developer ID signatures on ${result.binaryCount} Mach-O binaries`);
};
