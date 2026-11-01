import { createPrivateKey } from "node:crypto";
import { secureUrl } from "../protocol";

export type EdgeEnvironment = Readonly<Record<string, string | undefined>>;
export type EdgeRole = "api" | "webhook" | "worker";
export interface EdgeConfiguration {
	url: string;
	publicKey: string;
	adminKey: string;
	appId: string;
	privateKey: string;
	analysisVersion: string;
	webhookSecret: string;
	workerSecret: string;
	modelKey: string;
}
export interface ConfigurationStatus {
	missing: string[];
	invalid: string[];
}

/** Pure configuration inspection: never reads process.env or contacts a provider. */
export function edgeConfiguration(env: EdgeEnvironment, role: EdgeRole) {
	const value = (key: string) => env[key]?.trim() ?? "";
	let dictionaryKey = "";
	let dictionaryValues: string[] = [];
	try {
		const keys: unknown = JSON.parse(value("SUPABASE_PUBLISHABLE_KEYS") || "{}");
		if (keys && typeof keys === "object") {
			dictionaryValues = Object.values(keys).filter(
				(key): key is string => typeof key === "string"
			);
			if ("default" in keys && typeof keys.default === "string")
				dictionaryKey = keys.default.trim();
		}
	} catch {
		// The explicit/legacy public key still takes precedence over a malformed dictionary.
	}
	const config: EdgeConfiguration = {
		url: value("TEAM_SUPABASE_URL") || value("SUPABASE_URL"),
		publicKey:
			value("TEAM_SUPABASE_PUBLISHABLE_KEY") ||
			value("SUPABASE_PUBLISHABLE_KEY") ||
			dictionaryKey ||
			value("SUPABASE_ANON_KEY"),
		adminKey: value("TEAM_SUPABASE_SERVICE_ROLE_KEY") || value("SUPABASE_SERVICE_ROLE_KEY"),
		appId: value("GITHUB_APP_ID"),
		privateKey: value("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
		analysisVersion: value("TEAM_ANALYSIS_VERSION"),
		webhookSecret: value("GITHUB_WEBHOOK_SECRET"),
		workerSecret: value("TEAM_WORKER_INVOKE_SECRET"),
		modelKey: value("MODEL_API_KEY") || value("META_API_KEY"),
	};
	const status: ConfigurationStatus = { missing: [], invalid: [] };
	const requireValue = (key: keyof EdgeConfiguration, name: string) => {
		if (!config[key]) status.missing.push(name);
	};
	requireValue("url", "SUPABASE_URL");
	requireValue("adminKey", "SUPABASE_SERVICE_ROLE_KEY");
	if (config.url) {
		try {
			secureUrl(config.url);
		} catch {
			status.invalid.push("SUPABASE_URL");
		}
	}
	// SupabaseRest's existing admin path uses the legacy service-role JWT as Bearer.
	if (config.adminKey.startsWith("sb_")) status.invalid.push("SUPABASE_SERVICE_ROLE_KEY");
	if (role === "api") {
		requireValue("publicKey", "SUPABASE_PUBLISHABLE_KEYS.default or SUPABASE_ANON_KEY");
		if (config.publicKey.startsWith("sb_secret_")) status.invalid.push("SUPABASE_PUBLISHABLE_KEY");
	}
	if (role !== "webhook") {
		requireValue("appId", "GITHUB_APP_ID");
		requireValue("privateKey", "GITHUB_APP_PRIVATE_KEY");
		requireValue("analysisVersion", "TEAM_ANALYSIS_VERSION");
		if (config.appId && !/^[1-9][0-9]*$/.test(config.appId)) status.invalid.push("GITHUB_APP_ID");
		if (config.analysisVersion.length > 160) status.invalid.push("TEAM_ANALYSIS_VERSION");
		if (config.privateKey) {
			try {
				if (createPrivateKey(config.privateKey).asymmetricKeyType !== "rsa") throw new Error();
			} catch {
				status.invalid.push("GITHUB_APP_PRIVATE_KEY");
			}
		}
	}
	if (role === "webhook") requireValue("webhookSecret", "GITHUB_WEBHOOK_SECRET");
	if (role === "worker") {
		requireValue("workerSecret", "TEAM_WORKER_INVOKE_SECRET");
		requireValue("modelKey", "MODEL_API_KEY or META_API_KEY");
		if (
			config.workerSecret &&
			(config.workerSecret.length < 32 ||
				config.workerSecret.length > 4096 ||
				[
					config.publicKey,
					config.adminKey,
					config.modelKey,
					config.webhookSecret,
					value("SUPABASE_ANON_KEY"),
					value("SUPABASE_PUBLISHABLE_KEY"),
					...dictionaryValues.map((key) => key.trim()),
				].includes(config.workerSecret))
		)
			status.invalid.push("TEAM_WORKER_INVOKE_SECRET");
	}
	return { config, status, ready: status.missing.length === 0 && status.invalid.length === 0 };
}
