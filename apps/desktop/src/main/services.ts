import { TRPCError } from "@trpc/server";
import { ConversationService } from "./agent/conversation";
import { MetaClient } from "./agent/meta-client";
import { ScreenContextStore } from "./agent/screen-context";
import { createAgentComposition } from "./composition";
import { type VoiceCompositionOptions, createVoiceComposition } from "./composition/voice";
import type { EnvConfiguration } from "./config/env";
import type { AppConfigurationPorts } from "./config/router";
import { BrowserService, type BrowserServiceOptions } from "./runtime/browser";
import type { RuntimeOptions, RuntimeService } from "./runtime/service";

let runtime: RuntimeService | undefined;
let dataDirectory: string | undefined;
let closing = false;
let browser: BrowserService | undefined;
let browserOptions: BrowserServiceOptions | undefined;
let voice: ReturnType<typeof createVoiceComposition> | undefined;
let configuration: EnvConfiguration | undefined;
let configurationPorts: AppConfigurationPorts | undefined;
export const screenContexts = new ScreenContextStore();
export const agentComposition = createAgentComposition({
	getRuntime: runtimeForActiveJobs,
	getDataDirectory: () => {
		if (!dataDirectory) throw new Error("Application storage is unavailable");
		return dataDirectory;
	},
	screenContexts,
	actionReceipts: true,
	browser: {
		execute: (command, signal) => getBrowser().execute(command, signal),
		observe: (sessionId, signal) => getBrowser().observe(sessionId, signal),
	},
	buildCommand: (pr) =>
		pr.repository === "demo/shop-web" && new URL(pr.url).hostname === "example.invalid"
			? { command: process.execPath, args: ["--experimental-strip-types", "scenarios/build.mjs"] }
			: undefined,
});

const conversationClient = new MetaClient({
	getApiKey: async () => (await getConfiguration().get("meta")) ?? null,
	recordUsage: (record) => agentComposition.usage.record("conversation", record),
});
export const conversationService = new ConversationService(conversationClient, {
	getContext: (prId, signal) => getRuntime().github.prContext(prId, signal),
});

export function initializeConfiguration(value: EnvConfiguration): void {
	configuration = value;
}
export function getConfiguration(): EnvConfiguration {
	if (closing || !configuration) throw new Error("App configuration is unavailable");
	return configuration;
}
export function initializeConfigurationPorts(value: AppConfigurationPorts): void {
	configurationPorts = value;
}
export function getConfigurationPorts(): AppConfigurationPorts {
	if (!configurationPorts) throw new Error("App configuration is unavailable");
	return configurationPorts;
}

export function initializeBrowser(options: BrowserServiceOptions): void {
	browserOptions = options;
}
export function getBrowser(): BrowserService {
	if (closing || !browserOptions) throw new Error("Review browser is unavailable");
	browser ??= new BrowserService(browserOptions);
	return browser;
}
export async function closeBrowser(): Promise<void> {
	const current = browser;
	browser = undefined;
	await current?.dispose();
}
export function initializeVoice(
	options: Omit<VoiceCompositionOptions, "getCredentials" | "getDataDirectory">
): void {
	if (voice) throw new Error("Voice has already been initialized");
	voice = createVoiceComposition({
		...options,
		getDataDirectory: () => {
			if (!dataDirectory) throw new Error("Application storage is unavailable");
			return dataDirectory;
		},
		getCredentials: async () => {
			const credentials = runtimeForActiveJobs().credentials;
			const [meta, elevenlabs] = await Promise.all([
				credentials.get("meta"),
				credentials.get("elevenlabs"),
			]);
			return { meta, elevenlabs };
		},
		getVoiceId: () => getConfiguration().voiceId(),
		setVoiceId: (value) => getConfiguration().setVoiceId(value),
	});
}
export function getVoice(): ReturnType<typeof createVoiceComposition> {
	if (closing || !voice) throw new Error("Voice is unavailable");
	return voice;
}

export function initializeRuntime(options: RuntimeOptions): void {
	if (runtime) throw new Error("Runtime has already been initialized");
	dataDirectory = options.userDataPath;
	runtime = agentComposition.createRuntime(options);
}

export function getRuntime(): RuntimeService {
	if (closing) {
		throw new TRPCError({
			code: "SERVICE_UNAVAILABLE",
			message: "Review runtime is shutting down",
		});
	}
	return runtimeForActiveJobs();
}

function runtimeForActiveJobs(): RuntimeService {
	if (!runtime) {
		throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Review runtime is unavailable" });
	}
	return runtime;
}

export async function disposeRuntime(): Promise<void> {
	const current = runtime;
	closing = true;
	try {
		try {
			await voice?.dispose();
		} finally {
			await conversationService.dispose();
			// Drain provider, confirmation and source jobs while runtime/ledger remain available.
			await agentComposition.dispose();
		}
	} finally {
		try {
			await closeBrowser();
		} finally {
			runtime = undefined;
			voice = undefined;
			screenContexts.clear();
			await current?.dispose();
			dataDirectory = undefined;
		}
	}
}
