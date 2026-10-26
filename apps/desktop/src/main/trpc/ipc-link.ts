import { TRPCError, callTRPCProcedure, getTRPCErrorFromUnknown } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";
import { type BrowserWindow, ipcMain } from "electron";
import superjson from "superjson";
import { z } from "zod";
import type { TrpcRequest, TrpcResponse } from "../../shared/types";
import { appRouter } from "./routers";

const requestSchema = z.object({
	type: z.enum(["query", "mutation"]),
	path: z.string().min(1),
	input: z.object({ json: z.unknown() }).passthrough(),
});

export function setupTRPCIPC(getWindow: () => BrowserWindow | null): void {
	ipcMain.handle("trpc:request", async (event, request: TrpcRequest): Promise<TrpcResponse> => {
		try {
			const window = getWindow();
			if (
				!window ||
				event.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame
			) {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}

			requestSchema.parse(request);
			const data = await callTRPCProcedure({
				router: appRouter,
				path: request.path,
				type: request.type,
				getRawInput: async () => superjson.deserialize(request.input),
				ctx: {},
				signal: undefined,
				batchIndex: 0,
			});
			return { result: { data: superjson.serialize(data) } };
		} catch (cause) {
			const error =
				cause instanceof z.ZodError
					? new TRPCError({ code: "BAD_REQUEST", cause })
					: getTRPCErrorFromUnknown(cause);
			return {
				error: {
					message: error.message,
					code: TRPC_ERROR_CODES_BY_KEY[error.code],
					data: { code: error.code, httpStatus: getHTTPStatusCodeFromError(error) },
				},
			};
		}
	});
}
