import { z } from "zod";
import {
	SlackMessagePageSchema,
	SlackViewTargetSchema,
	decodeSlackViewTarget,
} from "../../shared/contracts/chat";
import type { SlackClient } from "../slack/client";
import { type SlackCredential, SlackError } from "../slack/types";

const ReadSchema = SlackViewTargetSchema.extend({ cursor: z.string().max(2000).optional() });
const identity = (credential: SlackCredential) =>
	JSON.stringify([
		credential.connectionId,
		credential.workspaceId,
		credential.userId,
		credential.appId,
		[...credential.scopes].sort(),
	]);

async function shortRetry<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (
			!(error instanceof SlackError) ||
			error.code !== "rate-limited" ||
			!error.retryAfterSeconds ||
			error.retryAfterSeconds <= 0 ||
			error.retryAfterSeconds > 2
		)
			throw error;
		const delayMs = error.retryAfterSeconds * 1000;
		await new Promise<void>((resolve, reject) => {
			const abort = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				reject(new SlackError("cancelled"));
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", abort);
				resolve();
			}, delayMs);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
		return work();
	}
}
/** Read-only provider data. Root binds the selected account; source text never supplies authority. */
export class SlackReader {
	constructor(
		private readonly ports: {
			getClient(): Pick<SlackClient, "conversation" | "history" | "thread" | "authorLabels">;
			getCredential(): Promise<SlackCredential | undefined>;
			getEpoch(): number;
		}
	) {}
	private async run<T>(
		signal: AbortSignal,
		work: (
			client: ReturnType<SlackReader["ports"]["getClient"]>,
			credential: SlackCredential
		) => Promise<T>
	) {
		signal.throwIfAborted();
		const credential = await this.ports.getCredential();
		if (!credential) throw new SlackError("connection-required");
		const epoch = this.ports.getEpoch();
		const client = this.ports.getClient();
		const result = await work(client, credential);
		signal.throwIfAborted();
		const current = await this.ports.getCredential();
		if (
			this.ports.getEpoch() !== epoch ||
			this.ports.getClient() !== client ||
			!current ||
			identity(current) !== identity(credential)
		)
			throw new SlackError("stale-connection");
		signal.throwIfAborted();
		return result;
	}
	async conversation(conversationId: string, signal = AbortSignal.timeout(30_000)) {
		const target = SlackViewTargetSchema.parse({ conversationId, threadTs: null });
		return this.run(signal, (client) => client.conversation(target.conversationId, signal));
	}
	async target(encoded: string, signal: AbortSignal) {
		const target = decodeSlackViewTarget(encoded);
		const conversation = await this.conversation(target.conversationId, signal);
		const name = conversation.visibility.endsWith("channel")
			? `#${conversation.name}`
			: conversation.name;
		return { id: encoded, title: target.threadTs ? `Thread · ${name}` : name };
	}
	async read(value: unknown, signal = AbortSignal.timeout(30_000)) {
		const input = ReadSchema.parse(value);
		return this.run(signal, async (client, credential) => {
			const conversation = await client.conversation(input.conversationId, signal);
			const page = await shortRetry(
				() =>
					input.threadTs
						? client.thread(
								{
									conversationId: input.conversationId,
									threadTs: input.threadTs,
									...(input.cursor ? { cursor: input.cursor } : {}),
								},
								signal
							)
						: client.history(
								{
									conversationId: input.conversationId,
									...(input.cursor ? { cursor: input.cursor } : {}),
								},
								signal
							),
				signal
			);
			const authors = await client.authorLabels(
				[...new Set(page.items.map((message) => message.authorId))],
				signal
			);
			return SlackMessagePageSchema.parse({
				actor: { workspaceId: credential.workspaceId, userId: credential.userId },
				conversation,
				items: page.items,
				authors,
				threadTs: input.threadTs,
				nextCursor: page.nextCursor,
				hasMore: page.hasMore,
			});
		});
	}
}
