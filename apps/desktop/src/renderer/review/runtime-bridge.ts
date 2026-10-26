import superjson from "superjson";
import {
	CredentialStatusListSchema,
	RemoveCredentialInputSchema,
	SetCredentialInputSchema,
	SourceFileRequestSchema,
	SourceFileSchema,
} from "../../shared/contracts";
import type { TrpcRequest, TrpcResponse } from "../../shared/types";
import { type SettingsAdapter, type SourceAdapter, configureReviewServices } from "./services";

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
	return { settings, sources };
}

export function connectAvailableRuntime() {
	let disposed = false;
	if (!window.electron?.trpc) return () => {};
	const bridge = createRuntimeBridge((input) => window.electron.trpc.request(input));
	void bridge.settings
		.status()
		.then(() => {
			if (!disposed) configureReviewServices(bridge);
		})
		.catch(() => {});
	return () => {
		disposed = true;
	};
}
