import {
	type AttentionClaim,
	AttentionPollResultSchema,
	type AttentionPresence,
	AttentionPresenceSchema,
	AttentionReceiptResultSchema,
	AttentionReleaseInputSchema,
	AttentionSettleInputSchema,
} from "../../shared/contracts";
import { bounded } from "../voice/async";
import type { ConversationApi } from "./api";
import type { ConversationController } from "./controller";

/** Composition owns DOM/native focus, overlays, typing and the recent-interaction window. */
export type AttentionSafetySnapshot = {
	enabled: boolean;
	reviewingCode?: boolean;
	focused: boolean;
	obscured: boolean;
	typing: boolean;
	recentInteraction: boolean;
	/** Must advance for every user interaction, including activity inside native guests. */
	activitySequence: number;
};
export type AttentionSafetyPort = {
	getSnapshot(): AttentionSafetySnapshot;
	subscribe(listener: () => void): () => void;
};

/** Root owns the polling timer; this binding owns renderer vetoes and playback receipts. */
export function createAttentionBinding(
	api: Pick<ConversationApi, "call">,
	ui: ConversationController,
	safety: AttentionSafetyPort,
	options: { now?: () => number; rpcTimeoutMs?: number } = {}
) {
	const now = options.now ?? Date.now;
	const timeout = options.rpcTimeoutMs ?? 15_000;
	let disposed = false;
	let polling = false;
	let epoch = 0;
	let safetyEpoch = 0;
	let delivery: AttentionClaim | null = null;
	let reviewEpoch = 0;
	let lastReview = !!safety.getSnapshot().reviewingCode;
	let lastActivity = safety.getSnapshot().activitySequence;
	const seen = new Set<string>();
	const pending = new Set<AbortController>();
	const safe = (state: AttentionSafetySnapshot) =>
		state.enabled && state.focused && !state.obscured && !state.typing && !state.recentInteraction;
	const eligible = () => !disposed && safe(safety.getSnapshot()) && ui.canStartAttention();
	const reviewAllows = (claim: AttentionClaim) =>
		!safety.getSnapshot().reviewingCode || claim.items.every((item) => item.kind === "decision");
	function remember(id: string) {
		seen.add(id);
		if (seen.size > 256) {
			const first = seen.values().next().value;
			if (first) seen.delete(first);
		}
	}
	async function receipt(path: "attention.release" | "attention.settle", input: unknown) {
		try {
			AttentionReceiptResultSchema.parse(
				await bounded(api.call("mutation", path, input), AbortSignal.timeout(timeout), timeout)
			);
		} catch {
			// No receipt is evidence of delivery. Main retains/retries the authoritative queue.
		}
	}
	async function release(claim: AttentionClaim) {
		if (seen.has(claim.id)) return;
		remember(claim.id);
		await receipt(
			"attention.release",
			AttentionReleaseInputSchema.parse({ sessionId: ui.sessionId, claimId: claim.id })
		);
	}
	function presence(): AttentionPresence {
		const state = safety.getSnapshot();
		const conversation = ui.store.getState();
		const enabled = state.enabled && conversation.handsFree && !conversation.handsFreeStarting;
		return AttentionPresenceSchema.parse({
			sessionId: ui.sessionId,
			enabled,
			focused: state.focused,
			obscured: state.obscured,
			activitySequence: state.activitySequence,
			reviewingCode: state.reviewingCode ?? false,
			state: !enabled
				? "disabled"
				: !safe(state)
					? "interacting"
					: conversation.active
						? ["connecting", "listening", "transcribing"].includes(conversation.phase)
							? "user-speaking"
							: "responding"
						: ui.canStartAttention()
							? "idle"
							: "user-speaking",
		});
	}
	const unsubscribeUi = ui.store.subscribe(() => {
		// A turn can begin and finish while a claim RPC is in flight.
		if (!eligible()) epoch++;
	});
	const unsubscribeSafety = safety.subscribe(() => {
		const state = safety.getSnapshot();
		const changed = state.activitySequence !== lastActivity;
		if (!!state.reviewingCode !== lastReview) reviewEpoch++;
		lastReview = !!state.reviewingCode;
		lastActivity = state.activitySequence;
		if (changed || !safe(state)) {
			epoch++;
			safetyEpoch++;
		}
		if (delivery && (changed || !safe(state) || !reviewAllows(delivery))) ui.interruptAttention();
	});
	return {
		async poll() {
			if (disposed || polling || delivery) return;
			polling = true;
			const before = presence();
			const version = epoch;
			const reviewVersion = reviewEpoch;
			const abort = new AbortController();
			pending.add(abort);
			const request = Promise.resolve().then(() => api.call("mutation", "attention.poll", before));
			// An IPC timeout/teardown does not cancel main. Release a late, unconsumed claim.
			void request
				.then((raw) => {
					if (!abort.signal.aborted) return;
					const result = AttentionPollResultSchema.safeParse(raw);
					if (result.success && result.data.claim) void release(result.data.claim);
				})
				.catch(() => {});
			try {
				const { claim } = AttentionPollResultSchema.parse(
					await bounded(request, abort.signal, timeout)
				);
				if (!claim || seen.has(claim.id)) return;
				if (
					before.state !== "idle" ||
					!eligible() ||
					!reviewAllows(claim) ||
					(reviewVersion !== reviewEpoch && claim.items.some((item) => item.kind !== "decision")) ||
					version !== epoch ||
					before.activitySequence !== safety.getSnapshot().activitySequence ||
					claim.sessionId !== ui.sessionId ||
					Date.parse(claim.expiresAt) <= now()
				) {
					await release(claim);
					return;
				}
				// Reserve synchronously before voice hooks publish state or can reenter polling.
				delivery = claim;
				const safetyVersion = safetyEpoch;
				const result = ui.startAttention(claim.id);
				if (result.status !== "started") {
					delivery = null;
					await release(claim);
					return;
				}
				if (
					!safe(safety.getSnapshot()) ||
					safetyEpoch !== safetyVersion ||
					!reviewAllows(claim) ||
					(reviewVersion !== reviewEpoch && claim.items.some((item) => item.kind !== "decision"))
				)
					ui.interruptAttention();
				remember(claim.id);
				void result.completion.then(async (status) => {
					await receipt(
						"attention.settle",
						AttentionSettleInputSchema.parse({
							...result.identity,
							claimId: claim.id,
							status,
						})
					);
					if (delivery?.id === claim.id) delivery = null;
				});
			} catch {
				abort.abort();
			} finally {
				pending.delete(abort);
				polling = false;
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			epoch++;
			unsubscribeUi();
			unsubscribeSafety();
			for (const abort of pending) abort.abort();
			pending.clear();
			if (delivery) ui.interruptAttention();
		},
	};
}
