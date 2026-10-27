import superjson from "superjson";
import { z } from "zod";
import {
	AgentTurnInputSchema,
	BrowserCommandSchema,
	BrowserObserveInputSchema,
	BrowserPresentInputSchema,
	BrowserStateSchema,
	CancelTurnInputSchema,
	CancelTurnResultSchema,
	ConfirmCommentInputSchema,
	DiagramSpecSchema,
	DraftedCommentSchema,
	IdSchema,
	PRPreparationSchema,
	PollTurnSchema,
	PreviewSchema,
	ScenarioTraceSchema,
	ScreenContextSchema,
	ScreenContextUpdateSchema,
	TurnIdentitySchema,
} from "../../shared/contracts";
import type { TrpcRequest, TrpcResponse } from "../../shared/types";
import { reviewErrorMessage } from "./errors";
import { createPollingAgentAdapter } from "./polling-adapter";
import type { BrowserAdapter, DraftAdapter, ReviewAdapter } from "./services";

export type ReviewRequest = (input: TrpcRequest) => Promise<TrpcResponse>;
export function createReviewRpc(request: ReviewRequest) {
	return async (type: "query" | "mutation", path: string, input?: unknown): Promise<unknown> => {
		const response = await request({ type, path, input: superjson.serialize(input) });
		if ("error" in response) throw new Error(reviewErrorMessage(response.error.message));
		return superjson.deserialize(response.result.data);
	};
}

/** All calls use the application's existing isolated request transport. */
export function createCompositionBridge(request: ReviewRequest) {
	const call = createReviewRpc(request);
	const agent = createPollingAgentAdapter({
		updateScreen: async (sessionId, screenContext) => {
			ScreenContextSchema.parse(
				await call(
					"mutation",
					"screen.update",
					ScreenContextUpdateSchema.parse({ sessionId, screenContext })
				)
			);
		},
		start: async (input) => {
			const result = await call("mutation", "agent.start", AgentTurnInputSchema.parse(input));
			return TurnIdentitySchema.extend({
				status: z.enum(["running", "completed", "cancelled", "error"]),
			}).parse(result);
		},
		poll: (input) => call("query", "agent.poll", PollTurnSchema.parse(input)),
		cancel: async (input) => {
			CancelTurnResultSchema.parse(
				await call("mutation", "agent.cancel", CancelTurnInputSchema.parse(input))
			);
		},
		getScenario: async (id) =>
			ScenarioTraceSchema.parse(
				await call("query", "artifacts.getScenario", { id: IdSchema.parse(id) })
			),
		getPreview: async (id) =>
			PreviewSchema.parse(await call("query", "artifacts.getPreview", { id: IdSchema.parse(id) })),
		getDiagram: async (id) =>
			DiagramSpecSchema.parse(
				await call("query", "artifacts.getDiagram", { id: IdSchema.parse(id) })
			),
	});
	const review: ReviewAdapter = {
		prepare: async (prId) =>
			PRPreparationSchema.parse(
				await call("mutation", "review.prepare", { prId: IdSchema.parse(prId) })
			),
	};
	const drafts: DraftAdapter = {
		edit: async (draftId, body) =>
			DraftedCommentSchema.parse(
				await call(
					"mutation",
					"agent.editDraft",
					z
						.strictObject({ draftId: IdSchema, body: z.string().min(1).max(20000) })
						.parse({ draftId, body })
				)
			),
		confirm: async (input) =>
			z
				.strictObject({ url: z.url() })
				.parse(
					await call("mutation", "agent.confirmComment", ConfirmCommentInputSchema.parse(input))
				),
	};
	const browser: BrowserAdapter = {
		execute: async (input) =>
			BrowserStateSchema.parse(
				await call("mutation", "browser.execute", BrowserCommandSchema.parse(input))
			),
		observe: async (sessionId) =>
			BrowserStateSchema.nullable().parse(
				await call("query", "browser.observe", BrowserObserveInputSchema.parse({ sessionId }))
			),
		present: async (sessionId, bounds) => {
			await call(
				"mutation",
				"browser.present",
				BrowserPresentInputSchema.parse({ sessionId, bounds })
			);
		},
	};
	return { agent, review, drafts, browser };
}
