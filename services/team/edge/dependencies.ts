import { MetaClient, type UsageRecord } from "../../../apps/desktop/src/main/agent/meta-client";
import { TeamAccess } from "../access";
import { TeamConsumer } from "../consumer";
import { HostedGitHub } from "../github";
import { SupabaseRest } from "../supabase";
import type { EdgeConfiguration } from "./config";

export function adminDatabase(config: EdgeConfiguration, transport: typeof fetch) {
	return new SupabaseRest({ url: config.url, key: config.adminKey, fetch: transport });
}
export function apiDependencies(config: EdgeConfiguration, transport: typeof fetch) {
	const admin = adminDatabase(config, transport);
	const access = new TeamAccess({
		admin,
		fetch: transport,
		user: (token) =>
			new SupabaseRest({ url: config.url, key: config.publicKey, token, fetch: transport }),
	});
	const github = new HostedGitHub({
		appId: config.appId,
		privateKey: config.privateKey,
		fetch: transport,
	});
	return { admin, access, github, analysisVersion: config.analysisVersion };
}

// The peer's finite TeamConsumer port is additive; root integrates it before deployment.
export type EdgeConsumerOptions = ConstructorParameters<typeof TeamConsumer>[0] & {
	maxRunMs: number;
};
export type ConsumerFactory = (options: EdgeConsumerOptions) => Pick<TeamConsumer, "tick">;

export function workerConsumer(
	config: EdgeConfiguration,
	transport: typeof fetch,
	maxRunMs: number,
	createConsumer: ConsumerFactory = (options) => new TeamConsumer(options),
	recordUsage: (record: UsageRecord) => void = () => {}
) {
	const deps = apiDependencies(config, transport);
	return createConsumer({
		db: deps.admin,
		github: deps.github,
		analysisVersion: deps.analysisVersion,
		model: new MetaClient({
			getApiKey: async () => config.modelKey,
			recordUsage,
			fetch: transport,
			// Reserve time for source/authorization rechecks and fenced database settlement.
			timeoutMs: Math.max(1, maxRunMs - 30_000),
		}),
		maxRunMs,
	});
}
