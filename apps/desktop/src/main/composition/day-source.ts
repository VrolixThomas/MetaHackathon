import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { type ChatMessage, ChatMessageSchema } from "../../shared/contracts/chat";
import { IdSchema } from "../../shared/contracts/common";
import type { DaySnapshot } from "../../shared/contracts/day";
import type { SlackClient } from "../slack/client";

const InputSchema = z.strictObject({ itemId: IdSchema, expectedRevision: z.int().positive() });
interface DaySourceView {
	snapshot(): Promise<DaySnapshot>;
}

/** A source read is fenced by both the authenticated Day instance and its exact item revision. */
export async function readDaySource(
	ports: { getDay(): DaySourceView; client: Pick<SlackClient, "sourceMessage" | "thread"> },
	value: unknown,
	signal: AbortSignal
): Promise<ChatMessage[]> {
	signal.throwIfAborted();
	const input = InputSchema.parse(value);
	const day = ports.getDay();
	const before = await day.snapshot();
	const item = before.items.find((row) => row.id === input.itemId);
	if (ports.getDay() !== day || !item?.source || item.revision !== input.expectedRevision)
		throw new Error("This source changed");
	const source = item.source.source;
	if (source.workspaceId !== before.actor.workspaceId || item.ownerUserId !== before.actor.userId)
		throw new Error("This source is unavailable");
	await ports.client.sourceMessage(source, signal);
	signal.throwIfAborted();
	const page = await ports.client.thread(
		{ conversationId: source.conversationId, threadTs: source.threadId ?? source.messageId },
		signal
	);
	signal.throwIfAborted();
	const after = await day.snapshot();
	const current = after.items.find((row) => row.id === item.id);
	if (
		ports.getDay() !== day ||
		current?.revision !== item.revision ||
		!isDeepStrictEqual(current.source, item.source) ||
		!isDeepStrictEqual(after.actor, before.actor)
	)
		throw new Error("This source changed");
	return z.array(ChatMessageSchema).max(15).parse(page.items);
}
