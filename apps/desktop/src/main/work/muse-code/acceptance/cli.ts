import { isAbsolute } from "node:path";
import { ANSWER } from "./fixture";
import { livePorts } from "./live-ports";
import { runAcceptance } from "./runner";

const args = process.argv.slice(2);
const usage =
	"Root only: MUSE_ROOT_LIVE_ACCEPTANCE=1 bun run apps/desktop/src/main/work/muse-code/acceptance/cli.ts --live-subscription --answer Aurora [--muse-path /absolute/path/to/muse] [--keep-fixture]. Creates REAL billable subscription model turns, resumes the exact fixture question, cancels a separate turn; never logs in, publishes, installs or launches Electron.";
if (args.includes("--help")) console.log(usage);
else {
	const pathIndex = args.indexOf("--muse-path");
	const musePath = pathIndex < 0 ? null : args[pathIndex + 1];
	const answerIndex = args.indexOf("--answer");
	const known = args.every(
		(arg, index) =>
			["--live-subscription", "--answer", "--muse-path", "--keep-fixture"].includes(arg) ||
			index === answerIndex + 1 ||
			(pathIndex >= 0 && index === pathIndex + 1)
	);
	if (
		process.env["MUSE_ROOT_LIVE_ACCEPTANCE"] !== "1" ||
		!args.includes("--live-subscription") ||
		answerIndex < 0 ||
		args[answerIndex + 1] !== ANSWER ||
		!known ||
		musePath === undefined ||
		(musePath !== null && !isAbsolute(musePath))
	) {
		console.error(usage);
		process.exitCode = 2;
	} else {
		const controller = new AbortController();
		const cancel = () => controller.abort();
		process.once("SIGINT", cancel);
		process.once("SIGTERM", cancel);
		try {
			const result = await runAcceptance(
				{ musePath, answer: ANSWER, keepFixture: args.includes("--keep-fixture") },
				livePorts(),
				controller.signal
			);
			console.log(
				JSON.stringify({
					status: result.report["status"],
					stage: result.report["stage"],
					failure: result.report["failure"] ?? null,
					report: result.reportPath,
				})
			);
			if (result.report["status"] !== "passed") process.exitCode = 1;
		} finally {
			process.removeListener("SIGINT", cancel);
			process.removeListener("SIGTERM", cancel);
		}
	}
}
