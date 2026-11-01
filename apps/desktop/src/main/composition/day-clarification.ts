import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ChatMessage } from "../../shared/contracts/chat";
import { IdSchema } from "../../shared/contracts/common";
import {
	type DayOperateInput,
	type DayOperationResult,
	type DaySnapshot,
	DaySnapshotSchema,
	DayWorkItemSchema,
} from "../../shared/contracts/day";

const inputSchema = z.strictObject({ itemId: IdSchema, expectedRevision: z.int().positive() });
interface DayView {
	snapshot(): Promise<DaySnapshot>;
}

/** Polling is metadata only: neither cached audience lists nor encrypted storage authorize reads. */
export function publicDaySnapshot(raw: DaySnapshot): DaySnapshot {
	const snapshot = DaySnapshotSchema.parse(raw);
	snapshot.items = snapshot.items.map((item) => {
		if (!item.clarification) return item;
		const { clarification: c, ...metadata } = item;
		return {
			...metadata,
			clarificationMetadata: {
				policyId: c.policy.id,
				policyRevision: c.policy.revision,
				status: c.status,
				confirmedAt: c.confirmedAt,
				expiresAt: c.expiresAt,
			},
		};
	});
	return snapshot;
}

export function publicDayResult(
	result: DayOperationResult,
	kind: string,
	freshProposal = false
): DayOperationResult {
	const snapshot = publicDaySnapshot(result.snapshot);
	if (kind === "propose_clarification" && freshProposal) {
		// This operation read only its target thread, not every cached item in the result.
		const fresh = result.snapshot.items.find((item) => item.id === result.itemId);
		if (fresh)
			snapshot.items = snapshot.items.map((item) =>
				item.id === fresh.id ? DayWorkItemSchema.parse(fresh) : item
			);
	}
	return { ...result, snapshot };
}

export async function operatePublicDay(
	getDay: () => DayView & { operate(input: DayOperateInput): Promise<DayOperationResult> },
	input: DayOperateInput
) {
	const day = getDay();
	const before = await day.snapshot();
	const op = input.operation;
	const freshProposal =
		op.kind === "propose_clarification" &&
		before.items.some((item) => item.id === op.itemId && item.revision === op.expectedRevision);
	const result = await day.operate(input);
	if (getDay() !== day || !isDeepStrictEqual(result.snapshot.actor, before.actor))
		throw new Error("The active source account changed");
	// An idempotent replay has already advanced the item revision and is not a fresh source read.
	return publicDayResult(result, op.kind, freshProposal);
}

/** Reuse the existing source reader's fresh membership/account/revision boundary, on inspection only. */
export async function readDayClarification(
	ports: {
		getDay(): DayView;
		readSource(input: z.infer<typeof inputSchema>, signal: AbortSignal): Promise<ChatMessage[]>;
	},
	raw: unknown,
	signal: AbortSignal
) {
	const input = inputSchema.parse(raw);
	const day = ports.getDay();
	const before = await day.snapshot();
	const item = before.items.find((i) => i.id === input.itemId);
	if (!item?.clarification || item.revision !== input.expectedRevision)
		throw new Error("This clarification changed");
	const messages = await ports.readSource(input, signal);
	signal.throwIfAborted();
	const after = await day.snapshot();
	const current = after.items.find((i) => i.id === input.itemId);
	if (
		ports.getDay() !== day ||
		!isDeepStrictEqual(before.actor, after.actor) ||
		!current ||
		current.revision !== item.revision ||
		!isDeepStrictEqual(current.clarification, item.clarification)
	)
		throw new Error("This clarification changed");
	const anchor = messages.find((m) =>
		isDeepStrictEqual(m.citation.source, item.clarification?.policy.source)
	);
	if (
		!anchor ||
		anchor.text !== item.clarification.policy.originalRequest ||
		!anchor.citation.audience.readerIds.includes(before.actor.userId) ||
		item.clarification.evidence.some(
			(old) =>
				!messages.some(
					(fresh) =>
						isDeepStrictEqual(fresh.citation.source, old.citation.source) &&
						fresh.text === old.text &&
						fresh.authorId === old.authorId &&
						!fresh.deletedAt &&
						!fresh.truncated &&
						fresh.citation.audience.readerIds.includes(before.actor.userId)
				)
		)
	)
		throw new Error("Clarification evidence changed or is unavailable");
	return DayWorkItemSchema.parse(current);
}
