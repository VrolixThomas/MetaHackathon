import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import superjson from "superjson";
import type { AppRouter } from "../../main/trpc/routers";

export function ipcLink(): TRPCLink<AppRouter> {
	return () =>
		({ op }) =>
			observable((observer) => {
				if (op.type === "subscription") {
					observer.error(new TRPCClientError("IPC subscriptions are not configured"));
					return;
				}

				window.electron.trpc
					.request({ type: op.type, path: op.path, input: superjson.serialize(op.input) })
					.then((response) => {
						if ("error" in response) {
							observer.error(TRPCClientError.from(response));
							return;
						}
						observer.next({
							result: { type: "data", data: superjson.deserialize(response.result.data) },
						});
						observer.complete();
					})
					.catch((error: unknown) => {
						observer.error(
							TRPCClientError.from(error instanceof Error ? error : new Error(String(error)))
						);
					});
			});
}
