import { type ChildProcess, fork } from "node:child_process";
import { z } from "zod";
import type { CodingProviderSettings } from "../../../shared/contracts/coding-provider";
import {
	type CodingTaskInput,
	CodingTaskInputSchema,
	type CodingTaskResult,
	CodingTaskResultSchema,
} from "../../agent/coding-worker";
import { codingEnvironment } from "../coding-environment";

const eventSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("log"), text: z.string().max(12000) }),
	z.strictObject({ kind: z.literal("result"), result: CodingTaskResultSchema }),
	z.strictObject({ kind: z.literal("failed"), message: z.string().max(1000) }),
]);
interface ChildOptions {
	workerEntry: string;
	envPath: string;
	providerSettings?: CodingProviderSettings;
	log: (text: string) => void;
	assertLive: () => void;
	/** Pure protocol probes may inject a controlled process; production always uses Node fork. */
	spawn?: typeof fork;
}

/** Same private IPC protocol as coding-entry.ts; credentials only enter through main's env file. */
export function runPRFixChild(
	options: ChildOptions,
	raw: CodingTaskInput,
	signal: AbortSignal
): Promise<CodingTaskResult> {
	const input = CodingTaskInputSchema.parse(raw);
	options.assertLive();
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = (options.spawn ?? fork)(options.workerEntry, [], {
				silent: true,
				serialization: "json",
				execArgv: [],
				env: codingEnvironment({ ELECTRON_RUN_AS_NODE: "1" }),
			});
		} catch {
			reject(new Error("The coding worker could not launch."));
			return;
		}
		let result: CodingTaskResult | undefined;
		let failure: Error | undefined;
		let settled = false;
		let terminating = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (code: number | null = null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			if (code !== 0) failure ??= new Error("The coding worker did not exit cleanly.");
			try {
				options.assertLive();
				signal.throwIfAborted();
			} catch {
				failure = new Error("The coding worker was interrupted.");
			}
			if (failure || !result)
				reject(failure ?? new Error("The coding worker exited without a result."));
			else resolve(result);
		};
		const terminate = () => {
			if (settled || terminating) return;
			terminating = true;
			clearTimeout(timer);
			timer = undefined;
			try {
				if (child.connected) child.send({ kind: "cancel" }, () => {});
			} catch {}
			child.kill("SIGTERM");
			timer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 2000);
			timer.unref?.();
		};
		const abort = () => {
			failure = new Error("The coding worker was interrupted.");
			terminate();
		};
		signal.addEventListener("abort", abort, { once: true });
		const log = (value: unknown) => {
			try {
				options.assertLive();
				signal.throwIfAborted();
				options.log(String(value));
			} catch {
				abort();
			}
		};
		child.stdout?.on("data", log);
		child.stderr?.on("data", log);
		child.on("message", (raw) => {
			try {
				options.assertLive();
				signal.throwIfAborted();
			} catch {
				abort();
				return;
			}
			if (result || failure) return;
			const event = eventSchema.safeParse(raw);
			if (!event.success) {
				failure = new Error("The coding worker returned an invalid receipt.");
				terminate();
				return;
			}
			if (event.data.kind === "log") log(event.data.text);
			else if (event.data.kind === "result") {
				result = event.data.result;
				// A result is not permission for an unbounded lingering process.
				timer = setTimeout(() => {
					child.kill("SIGTERM");
					timer = setTimeout(() => child.kill("SIGKILL"), 2000);
					timer.unref?.();
				}, 2000);
				timer.unref?.();
			} else {
				failure = new Error("The coding worker could not complete.");
				terminate();
			}
		});
		child.once("error", () => {
			failure = new Error("The coding worker could not launch.");
			terminate();
			if (!child.pid) finish();
		});
		child.once("exit", finish);
		try {
			options.assertLive();
			signal.throwIfAborted();
			child.send(
				{
					kind: "run",
					input,
					envPath: options.envPath,
					...(options.providerSettings ? { providerSettings: options.providerSettings } : {}),
				},
				(error) => {
					if (error) {
						failure = new Error("The coding worker could not receive its task.");
						terminate();
					}
				}
			);
		} catch {
			failure = new Error("The coding worker was interrupted.");
			terminate();
		}
	});
}
