import superjson from "superjson";
import {
	CredentialStatusListSchema,
	PreviewSchema,
	PullRequestSchema,
	RemoveCredentialInputSchema,
	RepositoryPathSchema,
	ScenarioTraceSchema,
	SetCredentialInputSchema,
	SourceFileRequestSchema,
	SourceFileSchema,
} from "../../shared/contracts";
import type { TrpcRequest, TrpcResponse } from "../../shared/types";
import { createCompositionBridge } from "./composition-bridge";
import {
	type ArtifactAdapter,
	type RuntimeAdapter,
	type SettingsAdapter,
	type SourceAdapter,
	configureReviewServices,
} from "./services";

type Request = (input: TrpcRequest) => Promise<TrpcResponse>;

/** Uses the existing isolated IPC bridge; credentials are never query/mutation-cache entries. */
export function createRuntimeBridge(request: Request) {
	const call = async (type: "query" | "mutation", path: string, input?: unknown) => {
		const result = await request({ type, path, input: superjson.serialize(input) });
		if ("error" in result) throw new Error("Runtime request failed");
		return superjson.deserialize(result.result.data);
	};
	const settings: SettingsAdapter = {
		status: async () =>
			CredentialStatusListSchema.parse(await call("query", "runtime.credentialStatus")),
		set: async (provider, value) => {
			await call(
				"mutation",
				"runtime.setCredential",
				SetCredentialInputSchema.parse({ provider, secret: value })
			);
		},
		remove: async (provider) => {
			await call(
				"mutation",
				"runtime.deleteCredential",
				RemoveCredentialInputSchema.parse({ provider })
			);
		},
		signInGitHub: async () => {
			await call("mutation", "runtime.githubSignIn");
		},
	};
	const sources: SourceAdapter = {
		read: async (input) =>
			SourceFileSchema.parse(
				await call("query", "runtime.source", SourceFileRequestSchema.parse(input))
			),
	};
	const mutation = async (path: string, input: Record<string, unknown>, signal?: AbortSignal) => {
		signal?.throwIfAborted();
		const requestId = crypto.randomUUID();
		const cancel = () => {
			void call("mutation", "runtime.cancel", { requestId }).catch(() => {});
		};
		signal?.addEventListener("abort", cancel, { once: true });
		try {
			const value = await call("mutation", path, { ...input, requestId });
			signal?.throwIfAborted();
			return value;
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
	};
	const runtime: RuntimeAdapter = {
		prepareDemo: async () =>
			PullRequestSchema.array().parse(await call("mutation", "runtime.prepareDemo")),
		changedFiles: async (prId) =>
			RepositoryPathSchema.array().parse(await call("query", "runtime.changedFiles", { prId })),
		runScenario: async (prId, scenarioId, signal) => {
			const result = await mutation("runtime.runScenario", { prId, scenarioId }, signal);
			if (typeof result !== "object" || !result || !("trace" in result))
				throw new Error("Missing scenario trace");
			return ScenarioTraceSchema.parse(result.trace);
		},
		startPreview: async (prId, mode, signal) =>
			PreviewSchema.parse(await mutation("runtime.startPreview", { prId, mode }, signal)),
		stopPreview: async (id) => {
			await call("mutation", "runtime.stopPreview", { id });
		},
	};
	const artifacts: ArtifactAdapter = {
		resizePreview: async (preview, mode, signal) => {
			signal?.throwIfAborted();
			await runtime.stopPreview(preview.id);
			signal?.throwIfAborted();
			return runtime.startPreview(preview.prId, mode, signal);
		},
	};
	return { settings, sources, runtime, artifacts };
}

export function connectAvailableRuntime() {
	let disposed = false;
	if (!window.electron?.trpc) return () => {};
	const bridge = createRuntimeBridge((input) => window.electron.trpc.request(input));
	void bridge.settings
		.status()
		.then(() => {
			if (!disposed)
				configureReviewServices({
					...bridge,
					...createCompositionBridge((input) => window.electron.trpc.request(input)),
				});
		})
		.catch(() => {});
	return () => {
		disposed = true;
	};
}
