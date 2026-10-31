const path = require("node:path");
const { verifyPackagedPayload, targetArchitectures } = require("./payload.cjs");

module.exports = async (context) => {
	if (context.electronPlatformName !== "darwin") return;
	const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	const result = verifyPackagedPayload(appPath, targetArchitectures(context.arch));
	console.log(
		`Verified production payload: Muse SDK ${result.sdkVersion}; ${result.voice.binaryCount} voice Mach-O files`
	);
};
