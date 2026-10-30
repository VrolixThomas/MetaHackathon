import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRPCError } from "@trpc/server";
import type { ReviewCache } from "../shared/contracts";
import { ConversationService } from "./agent/conversation";
import { MetaClient } from "./agent/meta-client";
import { prepareReview } from "./agent/prepare-review";
import { ScreenContextStore } from "./agent/screen-context";
import { assessSuggestedFix } from "./agent/suggestion-review";
import { createAgentComposition } from "./composition";
import { LocalBrowserSurface } from "./composition/browser-surface";
import { ConversationDiagnostics } from "./composition/diagnostics";
import { ReviewCoordinator } from "./composition/reviews";
import { type VoiceCompositionOptions, createVoiceComposition } from "./composition/voice";
import { WorkspaceCoordinator } from "./composition/workspace";
import { createWorkspaceStore } from "./composition/workspace-store";
import type { EnvConfiguration } from "./config/env";
import type { AppConfigurationPorts } from "./config/router";
import type { HubStore } from "./db/hub-store";
import { OAuthService } from "./oauth/service";
import { type BrowserPage, BrowserService, type BrowserServiceOptions } from "./runtime/browser";
import type { CredentialAccess, SecretEncryption } from "./runtime/credentials";
import { HubGitHubClient } from "./runtime/hub-github";
import { HubLinearClient } from "./runtime/hub-linear";
import type { RuntimeOptions, RuntimeService } from "./runtime/service";
import { WorkJobRuntime } from "./runtime/work-job-runtime";
import { AttentionScheduler } from "./work/attention";
import { CommandCenterService } from "./work/hub";
import { WorkJobCoordinator } from "./work/jobs";
import { ReviewRegistry } from "./work/review-registry";

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
let oauth: OAuthService | undefined;
let configurationPorts: AppConfigurationPorts | undefined;
let reviews: ReviewCoordinator | undefined;
let workspace: WorkspaceCoordinator | undefined;
let hub: CommandCenterService | undefined;
let workJobs: WorkJobCoordinator | undefined;
let attention: AttentionScheduler | undefined;
let stopAttentionObserver: (() => void) | undefined;
let reviewRegistry: ReviewRegistry | undefined;
let hubReviewStore: HubStore | undefined;
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
	narrationCheckpoints: true,
	attention: {
		resolve: (input, signal) => getAttention().resolve(input, signal),
		validate: (input, signal) => getAttention().validate(input, signal),
	},
	hub: {
		snapshot: () => getHub().snapshot(),
		operate: (operation, requestId, signal) => getHub().operate(operation, requestId, signal),
		ticket: (id, signal) => getHub().ticket(id, signal),
		job: (id) => getHub().job(id),
		jobLog: (id, cursor, limit) => getWorkJobs().log(id, cursor, limit),
		feedback: (id, signal) => getHub().feedback(id, signal),
		reviewWork: (id) => getWorkJobs().review(id),
		source: (request, signal) => getHub().source(request, signal),
		search: (request, signal) => getHub().search(request, signal),
	},
	workspace: {
		observe: (sessionId, signal) => getWorkspace().observe(sessionId, signal),
		execute: (command, turn, signal, onAction) =>
			getWorkspace().execute(command, turn, signal, onAction),
		cancel: (turn) => workspace?.cancel(turn),
	},
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
		saveCache: async (cache) => {
			await store.save(cache);
			if (hubReviewStore && cache.repository)
				await hubReviewStore.saveReview(cache.repository, cache);
		},
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
export async function initializeHub(
	userDataPath: string,
	store: HubStore,
	legacyStore: { load(): ReviewCache | Promise<ReviewCache> },
	focused: () => boolean = () => false
) {
	if (!reviews) throw new Error("Review foundation unavailable");
	hubReviewStore = store;
	const github = new HubGitHubClient({ getToken: getGitHubToken });
	const linear = new HubLinearClient({ getKey: getLinearAuthorization });
	reviewRegistry = new ReviewRegistry(
		reviews,
		(repository) =>
			new ReviewCoordinator({
				loadCache: async () =>
					(await store.loadReview(repository.repository)) ?? {
						repository: repository.repository,
						localPath: repository.localPath,
						prepared: [],
						progress: [],
					},
				saveCache: (cache) => store.saveReview(repository.repository, cache),
				listOpen: async (name, signal) =>
					(await github.reviews(name, signal)).map((item) => item.pr),
				readPR: (id, signal) => {
					const match = /^([^#]+)#([1-9][0-9]*)$/.exec(id);
					if (!match) throw new Error("Invalid PR");
					return runtimeForActiveJobs().github.readPullRequest(
						match[1] ?? "",
						Number(match[2]),
						signal
					);
				},
				getContext: (id, signal) => runtimeForActiveJobs().prContext(id, signal),
				readFile: (input, localPath, signal) =>
					runtimeForActiveJobs().reviewFile(input, signal, localPath ?? undefined),
				validateLocal: (path, name, signal) =>
					runtimeForActiveJobs().validateLocalRepository(path, name, signal),
				prepare: (context, signal) => prepareReview(conversationClient, context, signal),
			})
	);
	hub = new CommandCenterService({
		store,
		github,
		linear,
		registry: reviewRegistry,
		legacyCache: () => Promise.resolve(legacyStore.load()),
		connections: async () => ({
			github: !!(await (oauth
				? oauth.hasCredentials("github")
				: getConfiguration().get("github")
			).catch(() => false)),
			linear: !!(await (oauth
				? oauth.hasCredentials("linear")
				: getConfiguration().linearToken()
			).catch(() => false)),
			model: !!(await getConfiguration()
				.get("meta")
				.catch(() => undefined)),
		}),
	});
	await hub.initialize();
	const values = (
		await Promise.all([
			getConfiguration()
				.get("meta")
				.catch(() => undefined),
			getConfiguration()
				.get("github")
				.catch(() => undefined),
			getConfiguration()
				.get("elevenlabs")
				.catch(() => undefined),
			getConfiguration()
				.linearToken()
				.catch(() => undefined),
		])
	).filter((value): value is string => !!value && value.length > 5);
	const redact = (text: string) =>
		values.reduce((clean, value) => clean.split(value).join("[redacted]"), text);
	const runtime = new WorkJobRuntime({
		directory: join(userDataPath, "work", "git"),
		getToken: getGitHubToken,
	});
	workJobs = new WorkJobCoordinator({
		hub,
		runtime,
		github,
		linear,
		directory: join(userDataPath, "work", "jobs"),
		workerEntry: join(dirname(fileURLToPath(import.meta.url)), "coding-worker.js"),
		envPath: getConfiguration().path,
		assessSuggestion: (job, review, signal) =>
			assessSuggestedFix(conversationClient, job, review, signal),
		redact,
	});
	hub.attachJobs(workJobs);
	attention = new AttentionScheduler({
		read: () => getHub().attentionState(),
		update: (mutator) => getHub().update(mutator),
		isBusy: (sessionId) => conversationService.isBusy(sessionId),
		completed: (turn, claimId) => conversationService.attentionCompleted(turn, claimId, "spoken"),
		interrupt: (turn) => {
			conversationService.cancel({
				...turn,
				requestId: `attention-interrupt-${turn.turnId}`,
				reason: "user",
			});
			void voice?.cancel(turn).catch(() => {});
		},
		focused,
	});
	stopAttentionObserver = hub.subscribe(() => {
		void attention?.changed().catch(() => {});
	});
	await workJobs.restore();
	void hub.refresh().catch(() => {});
}
export function getHub() {
	if (closing || !hub) throw new Error("Command center unavailable");
	return hub;
}
export function getWorkJobs() {
	if (closing || !workJobs) throw new Error("Work runtime unavailable");
	return workJobs;
}
export function getAttention() {
	if (closing || !attention) throw new Error("Attention is unavailable");
	return attention;
}
export function noteAttentionActivity() {
	attention?.noteActivity();
}

export function initializeWorkspace(userDataPath: string): void {
	const store = createWorkspaceStore(userDataPath);
	workspace = new WorkspaceCoordinator({
		getReviews,
		hubSnapshot: () => getHub().snapshot(),
		readSource: (location, signal) => getHub().source(location, signal),
		activateReview: (prId, signal) => reviewRegistry?.activate(prId, signal) ?? Promise.resolve(),
		getBrowser: () => ({
			open: async (url, signal) => {
				await getLocalBrowser().present({ bounds: null });
				return getLocalBrowser().open({ url }, signal);
			},
			observe: (signal) => getLocalBrowser().observe(signal),
			execute: (command, signal) => getLocalBrowser().executeBrowser(command, signal),
			state: () => getLocalBrowser().state(),
		}),
		loadCanvases: () => store.load(),
		saveCanvases: (value, signal) => store.save(value, signal),
	});
}
export function getWorkspace(): WorkspaceCoordinator {
	if (closing || !workspace) throw new Error("Workspace is unavailable");
	return workspace;
}
export function getReviews(): ReviewCoordinator {
	if (closing || !reviews) throw new Error("Review preparation is unavailable");
	return reviewRegistry?.getActive() ?? reviews;
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

export function initializeOAuth(
	userDataPath: string,
	encryption: SecretEncryption,
	openExternal: (url: string) => Promise<unknown>
) {
	if (oauth) throw new Error("OAuth has already been initialized");
	oauth = new OAuthService({
		directory: join(userDataPath, "oauth"),
		encryption,
		openExternal,
		getClient: (provider) => getConfiguration().oauthClient(provider),
		getManualToken: (provider) =>
			provider === "github" ? getConfiguration().get("github") : getConfiguration().linearToken(),
		clearManualToken: (provider) =>
			provider === "github"
				? getConfiguration().delete("github")
				: getConfiguration().setLinearToken(""),
		onChange: async (provider) => {
			await hub?.connectionChanged(provider);
		},
	});
}
export function getOAuth() {
	if (closing || !oauth) throw new Error("Account connections are unavailable");
	return oauth;
}
export function getGitHubToken() {
	return oauth ? oauth.token("github") : getConfiguration().get("github");
}
export function getLinearAuthorization() {
	return oauth ? oauth.authorization("linear") : getConfiguration().linearToken();
}
/** All existing GitHub/runtime consumers share the same authenticated account. */
export function authenticatedCredentials(): CredentialAccess {
	return {
		get: (provider) =>
			provider === "github" ? getGitHubToken() : getConfiguration().get(provider),
		set: async (provider, secret) => {
			await getConfiguration().set(provider, secret);
			if (provider === "github") await oauth?.clearSession("github");
		},
		delete: async (provider) => {
			await getConfiguration().delete(provider);
			if (provider === "github") await oauth?.clearSession("github");
		},
		status: async () => {
			const rows = await getConfiguration().status();
			const account = (await oauth?.status())?.find((row) => row.provider === "github");
			return rows.map((row) =>
				row.provider === "github" && account
					? {
							...row,
							configured: account.source !== null,
							storage: account.source === "oauth" ? "os-encrypted" : "env-file",
						}
					: row
			);
		},
	};
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
	localBrowser = new LocalBrowserSurface({ createPage, allowWebNavigation: true });
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
	stopAttentionObserver?.();
	await attention?.dispose().catch(() => {
		console.warn("Attention delivery state could not be saved during shutdown.");
	});
	closing = true;
	const stoppingOAuth = oauth?.dispose().catch(() => {
		console.warn("Account connection cleanup could not complete.");
	});
	try {
		try {
			await voice?.dispose();
		} finally {
			await conversationService.dispose();
			await workspace?.dispose();
			await workJobs?.dispose();
			await hub?.dispose();
			await stoppingOAuth;
			if (reviewRegistry) await reviewRegistry.dispose();
			else await reviews?.dispose();
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
