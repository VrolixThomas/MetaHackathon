import type { TRPCErrorShape } from "@trpc/server/rpc";
import type { SuperJSONResult } from "superjson";

export interface TrpcRequest {
	type: "query" | "mutation";
	path: string;
	input: SuperJSONResult;
}

export type TrpcResponse = { result: { data: SuperJSONResult } } | { error: TRPCErrorShape };

export interface ElectronAPI {
	trpc: { request: (request: TrpcRequest) => Promise<TrpcResponse> };
	attentionActivity?: { subscribe(listener: (event: { focused: boolean }) => void): () => void };
	voiceShortcut: {
		subscribe: (
			listener: (event: { phase: "press" | "release" | "toggle" | "cancel" }) => void
		) => () => void;
	};
}
