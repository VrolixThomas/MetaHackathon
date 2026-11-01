import {
	type DayOperateInput,
	DayOperateInputSchema,
	DayOperationResultSchema,
	DayOperationSchema,
	DaySnapshotSchema,
	DayWorkItemSchema,
} from "../../shared/contracts/day";
import type { ConversationApi } from "../conversation/api";
import type { DayApi } from "./controller";

/** Root registers these local IPC routes. No provider requests originate in the renderer. */
export function createDayApi(call: ConversationApi["call"]): DayApi {
	const unconfirmed = new Map<string, DayOperateInput>();
	return {
		snapshot: async () => DaySnapshotSchema.parse(await call("query", "day.snapshot", {})),
		inspectClarification: async (input) =>
			DayWorkItemSchema.parse(await call("query", "day.clarification", input)),
		operate: async (operation) => {
			const parsed = DayOperationSchema.parse(operation);
			const key = JSON.stringify(parsed);
			const input =
				unconfirmed.get(key) ??
				DayOperateInputSchema.parse({ requestId: crypto.randomUUID(), operation: parsed });
			// A lost acknowledgement must retry the same durable action, including manual capture.
			unconfirmed.set(key, input);
			const result = DayOperationResultSchema.parse(await call("mutation", "day.operate", input));
			if (result.requestId !== input.requestId) throw new Error("Day action identity mismatch");
			if ("itemId" in input.operation && result.itemId !== input.operation.itemId)
				throw new Error("Day item identity mismatch");
			unconfirmed.delete(key);
			return result;
		},
	};
}
