import superjson from "superjson";
import { z } from "zod";
import {
	AgentTurnStatusSchema,
	AppConfigurationSchema,
	type CancelTurnInput,
	CancelTurnInputSchema,
	CancelTurnResultSchema,
	ConversationPRContextSchema,
	type ConversationTurnInput,
	ConversationTurnInputSchema,
	HUB_ERROR_MESSAGES,
	IdSchema,
	MicrophoneStatusSchema,
	type PollTurn,
	PollTurnResultSchema,
	PollTurnSchema,
	PullRequestSchema,
	TurnIdentitySchema,
	VoiceSetupStatusSchema,
	WORKSPACE_GITHUB_REQUIRED,
} from "../../shared/contracts";
import type { TrpcRequest, TrpcResponse } from "../../shared/types";
import { conversationErrorMessage } from "./errors";

export type Request = (input: TrpcRequest) => Promise<TrpcResponse>;
const AccountSchema = z.object({ login: z.string().min(1), avatar_url: z.url() });
const StartSchema = TurnIdentitySchema.extend({ status: AgentTurnStatusSchema });

export function createConversationApi(request: Request) {
	const call = async (
		type: "query" | "mutation",
		path: string,
		input?: unknown
	): Promise<unknown> => {
		const response = await request({ type, path, input: superjson.serialize(input) });
		if ("error" in response)
			throw new Error(
				(path.startsWith("workspace.") && response.error.message === WORKSPACE_GITHUB_REQUIRED) ||
					(path.startsWith("hub.") &&
						Object.values(HUB_ERROR_MESSAGES).includes(
							response.error.message as (typeof HUB_ERROR_MESSAGES)[keyof typeof HUB_ERROR_MESSAGES]
						))
					? response.error.message
					: conversationErrorMessage(response.error.message)
			);
		return superjson.deserialize(response.result.data);
	};
	return {
		call,
		start: async (input: ConversationTurnInput) =>
			StartSchema.parse(
				await call("mutation", "conversation.start", ConversationTurnInputSchema.parse(input))
			),
		poll: async (input: PollTurn) =>
			PollTurnResultSchema.parse(
				await call("query", "conversation.poll", PollTurnSchema.parse(input))
			),
		cancel: async (input: CancelTurnInput) =>
			CancelTurnResultSchema.parse(
				await call("mutation", "conversation.cancel", CancelTurnInputSchema.parse(input))
			),
		release: async (sessionId: string) => {
			await call("mutation", "conversation.release", { sessionId: IdSchema.parse(sessionId) });
		},
		config: async () => AppConfigurationSchema.parse(await call("query", "app.config")),
		reloadConfig: async () =>
			AppConfigurationSchema.parse(await call("mutation", "app.reloadConfig")),
		openEnv: async () => {
			await call("mutation", "app.openEnv");
		},
		requestMicrophone: async () =>
			MicrophoneStatusSchema.parse(await call("mutation", "app.requestMicrophone")),
		voiceStatus: async () => VoiceSetupStatusSchema.parse(await call("query", "voice.status")),
		prepareVoice: async () => VoiceSetupStatusSchema.parse(await call("mutation", "voice.prepare")),
		githubSignIn: async () => AccountSchema.parse(await call("mutation", "runtime.githubSignIn")),
		githubAccount: async () => AccountSchema.parse(await call("query", "runtime.githubAccount")),
		reviewRequests: async () =>
			PullRequestSchema.array().parse(await call("query", "runtime.reviewRequests")),
		prContext: async (prId: string) =>
			ConversationPRContextSchema.parse(
				await call("query", "runtime.prContext", { prId: IdSchema.parse(prId) })
			),
	};
}
export type ConversationApi = ReturnType<typeof createConversationApi>;
