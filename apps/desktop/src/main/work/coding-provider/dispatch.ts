import { type CodingProviderSettings, MuseCodeStatusSchema } from "../../../shared/contracts";
import { throwIfAborted } from "../../agent/cancellation";
import {
	type CodingTaskInput,
	CodingTaskInputSchema,
	type CodingTaskResult,
	CodingTaskResultSchema,
} from "../../agent/coding-worker";
import { pinCodingProvider } from "./pin";

export interface CodingProviderPorts {
	meta(input: CodingTaskInput, signal: AbortSignal): Promise<CodingTaskResult>;
	muse(
		input: CodingTaskInput,
		options: { musePath: string | null },
		signal: AbortSignal
	): Promise<CodingTaskResult>;
	log(text: string): Promise<void>;
}

/** Provider errors propagate; this branch contains no fallback and never transforms provider checkpoints. */
export async function runPinnedCodingTask(
	raw: CodingTaskInput,
	readSettings: () => Promise<CodingProviderSettings>,
	ports: CodingProviderPorts,
	signal: AbortSignal
): Promise<CodingTaskResult> {
	const input = CodingTaskInputSchema.parse(raw);
	const pin = await pinCodingProvider(input, readSettings, signal);
	throwIfAborted(signal);
	await ports.log(`[coding-provider] Selected ${pin.settings.provider}`);
	throwIfAborted(signal);
	const confirmed = await pinCodingProvider(input, readSettings, signal);
	if (JSON.stringify(confirmed) !== JSON.stringify(pin))
		throw new Error("Pinned coding provider changed before dispatch");
	throwIfAborted(signal);
	const result =
		pin.settings.provider === "muse-code"
			? await ports.muse(input, { musePath: pin.settings.musePath }, signal)
			: await ports.meta(input, signal);
	throwIfAborted(signal);
	return CodingTaskResultSchema.parse(result);
}

/** Remove ambient provider/auth overrides before SDK import; the adapter also owns a subprocess allowlist. */
export function stripCodingProviderEnvironment(environment: NodeJS.ProcessEnv) {
	for (const key of Object.keys(environment)) {
		if (
			/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION)/i.test(key) ||
			/^(?:META_|MODEL_|GITHUB_|GH_|LINEAR_|SLACK_|ELEVENLABS_)/.test(key)
		)
			delete environment[key];
	}
}

/** Only fixed public status codes may enter logs; never forward an adapter exception or protocol frame. */
export function codingProviderFailureCode(error: unknown) {
	const raw = error && typeof error === "object" && "code" in error ? error.code : null;
	const code = MuseCodeStatusSchema.shape.error.safeParse(raw);
	return code.success ? code.data : null;
}
