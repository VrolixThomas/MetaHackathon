import { z } from "zod";
import { createStore } from "zustand/vanilla";
import {
	GitHubRepositorySchema,
	type HubOperation,
	HubOperationResultSchema,
	HubOperationSchema,
	type HubSnapshot,
	HubSnapshotSchema,
	IdSchema,
	LinearScopeSchema,
	LinearTicketSchema,
	PullRequestFeedbackSchema,
	RepositoryChoiceSchema,
	WorkJobSchema,
	WorkLogPageSchema,
	WorkReviewSchema,
} from "../../shared/contracts";
import type { ConversationApi } from "../conversation/api";

export const HUB_UNAVAILABLE =
	"Could not load your work. Check connections in Settings, then retry.";
export const HUB_OPERATION_FAILED =
	"The action could not be completed. Refresh to check its current state.";

/** Main owns durable jobs and polling providers. This controller only observes local IPC. */
export function createHubController(call: ConversationApi["call"]) {
	const store = createStore<{
		snapshot: HubSnapshot | null;
		busy: boolean;
		error: string;
	}>(() => ({ snapshot: null, busy: false, error: "" }));
	let disposed = false;
	let started = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let observing: Promise<void> | undefined;
	let operations = 0;
	let operationEpoch = 0;

	function adopt(snapshot: HubSnapshot) {
		if (disposed) return;
		const previous = store.getState().snapshot;
		if (!previous || snapshot.sequence >= previous.sequence) store.setState({ snapshot });
	}
	function observe() {
		if (disposed) return Promise.resolve();
		if (observing) return observing;
		const epoch = operationEpoch;
		observing = (async () => {
			if (!store.getState().snapshot) store.setState({ busy: true });
			try {
				const snapshot = HubSnapshotSchema.parse(await call("query", "hub.snapshot", {}));
				adopt(snapshot);
				if (!disposed && epoch === operationEpoch) store.setState({ error: "" });
			} catch {
				if (!disposed && epoch === operationEpoch) store.setState({ error: HUB_UNAVAILABLE });
			} finally {
				observing = undefined;
				if (!disposed) store.setState({ busy: operations > 0 });
			}
		})();
		return observing;
	}
	function schedule() {
		if (disposed || !started) return;
		timer = setTimeout(() => {
			void observe().finally(schedule);
		}, 3000);
	}
	async function start() {
		if (disposed || started) return;
		started = true;
		await observe();
		schedule();
	}
	async function operate(input: HubOperation) {
		if (disposed) return null;
		const operation = HubOperationSchema.parse(input);
		const epoch = ++operationEpoch;
		operations++;
		store.setState({ busy: true, error: "" });
		try {
			const result = HubOperationResultSchema.parse(
				await call("mutation", "hub.operate", { requestId: crypto.randomUUID(), operation })
			);
			if (disposed) return null;
			adopt(result.snapshot);
			return result;
		} catch {
			if (!disposed && epoch === operationEpoch) store.setState({ error: HUB_OPERATION_FAILED });
			return null;
		} finally {
			operations--;
			if (!disposed) store.setState({ busy: operations > 0 || !!observing });
		}
	}
	return {
		store,
		start,
		refresh: observe,
		operate,
		ticket: async (id: string) => {
			const ticket = LinearTicketSchema.parse(
				await call("query", "hub.ticket", { id: IdSchema.parse(id) })
			);
			if (ticket.id !== id) throw new Error("Ticket identity mismatch");
			return ticket;
		},
		job: async (id: string) => {
			const job = WorkJobSchema.parse(await call("query", "hub.job", { id: IdSchema.parse(id) }));
			if (job.id !== id) throw new Error("Job identity mismatch");
			return job;
		},
		jobLog: async (jobId: string, cursor = 0, limit = 100) => {
			const page = WorkLogPageSchema.parse(
				await call("query", "hub.jobLog", {
					jobId: IdSchema.parse(jobId),
					cursor: z.int().nonnegative().parse(cursor),
					limit: z.int().min(1).max(200).parse(limit),
				})
			);
			if (page.jobId !== jobId || page.cursor < cursor) throw new Error("Log identity mismatch");
			return page;
		},
		reviewWork: async (jobId: string) => {
			const review = WorkReviewSchema.parse(
				await call("query", "hub.reviewWork", { jobId: IdSchema.parse(jobId) })
			);
			if (
				review.job.id !== jobId ||
				review.files.some(
					(file) =>
						file.base.commitSha !== review.job.baseSha || file.head.commitSha !== review.job.headSha
				)
			)
				throw new Error("Local review revision mismatch");
			return review;
		},
		feedback: async (prId: string) => {
			const items = PullRequestFeedbackSchema.array()
				.max(1000)
				.parse(await call("query", "hub.feedback", { prId: IdSchema.parse(prId) }));
			if (items.some((item) => item.prId !== prId)) throw new Error("Feedback identity mismatch");
			return items;
		},
		repositories: async () =>
			RepositoryChoiceSchema.array()
				.max(1000)
				.parse(await call("query", "hub.repositories", {})),
		linearScopes: async () =>
			LinearScopeSchema.array()
				.max(1000)
				.parse(await call("query", "hub.linearScopes", {})),
		chooseRepository: async () =>
			z
				.strictObject({ repository: GitHubRepositorySchema, localPath: z.string().min(1) })
				.nullable()
				.parse(await call("mutation", "reviews.chooseRepository")),
		dispose() {
			disposed = true;
			started = false;
			clearTimeout(timer);
		},
	};
}
export type HubController = ReturnType<typeof createHubController>;
