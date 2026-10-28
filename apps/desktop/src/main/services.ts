import { TRPCError } from "@trpc/server";
import type { ReviewCache } from "../shared/contracts";
import { ConversationService } from "./agent/conversation";
import { MetaClient } from "./agent/meta-client";
import { prepareReview } from "./agent/prepare-review";
import { ScreenContextStore } from "./agent/screen-context";
import { createAgentComposition } from "./composition";
import { LocalBrowserSurface } from "./composition/browser-surface";
import { ConversationDiagnostics } from "./composition/diagnostics";
import { ReviewCoordinator } from "./composition/reviews";
import { type VoiceCompositionOptions, createVoiceComposition } from "./composition/voice";
import type { EnvConfiguration } from "./config/env";
import type { AppConfigurationPorts } from "./config/router";
import { type BrowserPage, BrowserService, type BrowserServiceOptions } from "./runtime/browser";
import type { RuntimeOptions, RuntimeService } from "./runtime/service";

let runtime: RuntimeService | undefined;
let dataDirectory: string | undefined;
let closing = false;
let diagnostics: ConversationDiagnostics | undefined;
export function initializeDiagnostics(userDataPath: string): void {
	diagnostics = new ConversationDiagnostics(userDataPath);
	diagnostics.record({ stage: "app-start" });
}
export function getDiagnostics(): ConversationDiagnostics | undefined {
	return diagnostics;
}
let browser: BrowserService | undefined;
let browserOptions: BrowserServiceOptions | undefined;
let localBrowser: LocalBrowserSurface | undefined;
let voice: ReturnType<typeof createVoiceComposition> | undefined;
let configuration: EnvConfiguration | undefined;
let configurationPorts: AppConfigurationPorts | undefined;
let reviews: ReviewCoordinator | undefined;
let chooseRepository: (() => Promise<{ repository: string; localPath: string } | null>) | undefined;
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
	review: {
		getReady: (prId, signal) => getReviews().getReady(prId, signal),
		getProgress: (prId, signal) => getReviews().getProgress(prId, signal),
		getScreen: (sessionId, initial) => getReviews().getScreen(sessionId, initial),
		navigate: (prId, request, signal) => getReviews().navigate(prId, request, signal),
		getFile: (prId, reviewId, path, signal) => getReviews().file({ prId, reviewId, path }, signal),
	},
	actionReceipts: {
		updateScreen: (receipt, navigation, signal) =>
			getReviews().actionApplied(receipt, navigation, signal),
	},
});

export function initializeReviews(
	store: {
		load(): ReviewCache | Promise<ReviewCache>;
		save(cache: ReviewCache): void | Promise<void>;
	},
	picker: () => Promise<{ repository: string; localPath: string } | null>
): void {
	chooseRepository = picker;
	reviews = new ReviewCoordinator({
		loadCache: () => store.load(),
		saveCache: (cache) => store.save(cache),
		listOpen: (repository, signal) =>
			runtimeForActiveJobs().repositoryPullRequests(repository, signal),
		readPR: (prId, signal) => {
			const match = /^([^#]+)#([1-9][0-9]*)$/.exec(prId);
			if (!match) throw new Error("Invalid pull request identifier");
			return runtimeForActiveJobs().github.readPullRequest(
				match[1] ?? "",
				Number(match[2]),
				signal
			);
		},
		getContext: (prId, signal) => runtimeForActiveJobs().prContext(prId, signal),
		readFile: (input, localPath, signal) =>
			runtimeForActiveJobs().reviewFile(input, signal, localPath ?? undefined),
		validateLocal: (path, repository, signal) =>
			runtimeForActiveJobs().validateLocalRepository(path, repository, signal),
		prepare: (context, signal) => prepareReview(conversationClient, context, signal),
	});
	void reviews
		.initialize()
		.catch(() => console.warn("Saved review connection could not initialize."));
}
export function getReviews(): ReviewCoordinator {
	if (closing || !reviews) throw new Error("Review preparation is unavailable");
	return reviews;
}
export function pickReviewRepository(): Promise<{ repository: string; localPath: string } | null> {
	if (closing || !chooseRepository) throw new Error("Repository picker is unavailable");
	return chooseRepository();
}

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
export function initializeLocalBrowser(createPage: (origin: string) => BrowserPage): void {
	if (localBrowser) throw new Error("Local browser has already been initialized");
	localBrowser = new LocalBrowserSurface({ createPage });
}
export function getLocalBrowser(): LocalBrowserSurface {
	if (closing || !localBrowser) throw new Error("Local browser is unavailable");
	return localBrowser;
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
			await reviews?.dispose();
			// Drain provider, confirmation and source jobs while runtime/ledger remain available.
			await agentComposition.dispose();
		}
	} finally {
		try {
			try {
				await localBrowser?.dispose();
			} finally {
				localBrowser = undefined;
				await closeBrowser();
			}
		} finally {
			runtime = undefined;
			voice = undefined;
			screenContexts.clear();
			await current?.dispose();
			dataDirectory = undefined;
		}
	}
}
