import { isAbsolute } from "node:path";
import { executionEnvironment } from "../runtime/environment";

/** Match the CLI probe's account roots without forwarding provider keys or shell hooks. */
export function codingEnvironment(extra: Record<string, string> = {}) {
	const env = executionEnvironment(extra);
	for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
		const value = process.env[key];
		if (
			value &&
			isAbsolute(value) &&
			!Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
		)
			env[key] = value;
	}
	return env;
}
