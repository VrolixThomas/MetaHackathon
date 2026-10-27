import { z } from "zod";
import { AppConfigurationSchema, MicrophoneStatusSchema } from "../../shared/contracts";
import { publicProcedure, router } from "../trpc";
import type { EnvConfiguration } from "./env";

export interface AppConfigurationPorts {
	configuration: () => EnvConfiguration;
	microphone: () => z.infer<typeof MicrophoneStatusSchema>;
	requestMicrophone: () => Promise<z.infer<typeof MicrophoneStatusSchema>>;
	openEnv: (path: string) => Promise<void>;
	reloadVoice: () => Promise<unknown>;
}

export function createAppConfigurationRouter(getPorts: () => AppConfigurationPorts) {
	const status = async () => {
		const ports = getPorts();
		const configuration = ports.configuration();
		let rows: Awaited<ReturnType<EnvConfiguration["status"]>> | undefined;
		let voiceId: string | null = null;
		let error: string | undefined;
		try {
			rows = await configuration.status();
			voiceId = (await configuration.voiceId()) ?? null;
		} catch {
			error = "Configuration file is invalid or unavailable. Open it to correct the values.";
		}
		return AppConfigurationSchema.parse({
			envPath: configuration.path,
			configured: rows
				? Object.fromEntries(rows.map((row) => [row.provider, row.configured]))
				: { meta: false, elevenlabs: false, github: false },
			voiceId,
			microphone: ports.microphone(),
			...(error ? { error } : {}),
		});
	};
	return router({
		config: publicProcedure.output(AppConfigurationSchema).query(status),
		reloadConfig: publicProcedure.output(AppConfigurationSchema).mutation(async () => {
			const ports = getPorts();
			await ports.configuration().reload();
			await ports.reloadVoice();
			return status();
		}),
		openEnv: publicProcedure.output(z.void()).mutation(async () => {
			const ports = getPorts();
			const configuration = ports.configuration();
			try {
				await stat(configuration.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					throw new Error("Configuration path is unavailable");
				await configuration.ensureTemplate();
			}
			await ports.openEnv(configuration.path);
		}),
		requestMicrophone: publicProcedure
			.output(MicrophoneStatusSchema)
			.mutation(() => getPorts().requestMicrophone()),
	});
}
import { stat } from "node:fs/promises";
