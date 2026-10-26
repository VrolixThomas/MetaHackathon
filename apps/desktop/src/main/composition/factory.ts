import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	ConfirmCommentInputSchema,
	type GeneratedScenario,
	GeneratedScenarioSchema,
	type PullRequest,
} from "../../shared/contracts";
import { CommentDrafts } from "../agent/comments";
import { MetaClient } from "../agent/meta-client";
import { type ScenarioTarget, ScenarioTargetSchema } from "../agent/scenario-proposals";
import { generateScenario } from "../agent/scenarios";
import type { ScreenContextStore } from "../agent/screen-context";
import { AgentService, StartTurnSchema } from "../agent/service";
import type { AgentPorts } from "../agent/tool-loop";
import { UsageLedger } from "../agent/usage";
import type { RuntimeOptions, RuntimeService } from "../runtime/service";
import { ArtifactCatalog } from "./catalog";
import { MainJobs } from "./jobs";
import { type ReviewOptions, ReviewPreparation } from "./review";
import { CatalogRuntimeService } from "./runtime";
import { PinnedSources, isSeeded, sameRevision } from "./source";

export interface AgentCompositionOptions extends ReviewOptions {
	getRuntime: () => RuntimeService;
	getDataDirectory: () => string;
	/** Supply the store registered under root screen; do not create a second screen cache. */
	screenContexts: ScreenContextStore;
	fetch?: typeof fetch;
	/** Main chooses exports/anchors; composition reads their committed source text. */
	scenarioTargets?: (
		pr: PullRequest,
		signal: AbortSignal
	) => Promise<Omit<ScenarioTarget, "sourceText">[]>;
}

export function createAgentComposition(options: AgentCompositionOptions) {
	const jobs = new MainJobs();
	const sources = new PinnedSources(options.getRuntime);
	const catalog = new ArtifactCatalog(sources);
	const accounting = new AsyncLocalStorage<string>();
	const hash = (value: string) => createHash("sha256").update(value).digest("hex");
	const usage = new UsageLedger(({ prId, record }) => {
		const directory = join(options.getDataDirectory(), "agent");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		// IDs can contain caller/provider text. Persist hashes and scalar accounting fields only.
		appendFileSync(
			join(directory, "usage.jsonl"),
			`${JSON.stringify({
				prHash: hash(prId),
				attemptId: record.attemptId,
				requestHash: hash(record.requestId),
				responseHash: record.responseId === null ? null : hash(record.responseId),
				model: record.model,
				status: record.status,
				usage: record.usage,
				estimatedUsd: record.estimatedUsd,
				pricingVerifiedAt: record.pricingVerifiedAt,
			})}\n`,
			{ mode: 0o600 }
		);
	});
	const client = new MetaClient({
		getApiKey: () =>
			jobs.run(async () => {
				const key = await options.getRuntime().credentials.get("meta");
				if (!key) throw new Error("Meta credential unavailable. Add your key in Settings.");
				return key;
			}),
		recordUsage: (record) => usage.record(accounting.getStore() ?? "unattributed", record),
		fetch: (input, init) =>
			jobs.run(async (signal) => {
				const response = await (options.fetch ?? fetch)(input, { ...init, signal });
				if (signal.aborted) {
					// Best effort: a late body's cleanup must not hold shutdown open.
					void Promise.resolve()
						.then(() => response.body?.cancel())
						.catch(() => {});
					signal.throwIfAborted();
				}
				return response;
			}, init?.signal ?? undefined),
	});
	const review = new ReviewPreparation(
		sources,
		catalog,
		jobs,
		client,
		options.screenContexts,
		options
	);

	class TrackedDrafts extends CommentDrafts {
		override confirmAndPost(raw: unknown, signal: AbortSignal) {
			return jobs.run(async (active) => {
				const input = ConfirmCommentInputSchema.parse(raw);
				const draft = this.get(input.draftId);
				// Perform local preflight before CommentDrafts enters its ambiguous-write state.
				if (draft.evidence.kind === "fixture")
					throw new Error("Fixture drafts cannot be posted to GitHub");
				if (
					input.draftRevision !== draft.revision ||
					input.body !== draft.body ||
					input.headSha !== draft.headSha
				)
					throw new Error("Confirmation is stale; review the current draft");
				const { pr } = sources.prepared(draft.prId);
				if (isSeeded(pr)) throw new Error("Seeded PR drafts cannot be posted to GitHub");
				if (draft.headSha !== pr.headSha) throw new Error("Draft head is no longer prepared");
				if (draft.location) await sources.location(pr, draft.location, active);
				return super.confirmAndPost(input, active);
			}, signal);
		}
	}
	const drafts = new TrackedDrafts({
		getPullRequest: (prId, signal) =>
			jobs.run(async (active) => {
				const { pr } = sources.prepared(prId);
				if (isSeeded(pr)) throw new Error("Seeded PR drafts cannot be posted to GitHub");
				return options.getRuntime().github.readPullRequest(pr.repository, pr.number, active);
			}, signal),
		postConfirmedComment: ({ draft, idempotencyKey, expectedHeadSha }, signal) =>
			jobs.run(async (active) => {
				const { pr } = sources.prepared(draft.prId);
				if (isSeeded(pr) || draft.evidence.kind === "fixture" || pr.headSha !== expectedHeadSha)
					throw new Error("Draft is not postable at the prepared head");
				return options.getRuntime().github.postConfirmedComment(
					pr,
					draft,
					{
						requestId: idempotencyKey,
						draftId: draft.id,
						draftRevision: draft.revision,
						body: draft.body,
						headSha: draft.headSha,
						confirmed: true,
					},
					active
				);
			}, signal),
	});
	const ports: AgentPorts = {
		getPreparation: (prId, signal) => review.prepare(prId, signal),
		getScreenContext: (sessionId, initial) =>
			jobs.run(async (signal) => {
				const screen = options.screenContexts.get(sessionId, initial);
				if (screen.focusedLocation)
					await sources.location(sources.prepared(screen.prId).pr, screen.focusedLocation, signal);
				return screen;
			}),
		getScenario: (prId, id, signal) => jobs.run(async () => catalog.getScenario(id, prId), signal),
		getPreview: (prId, id, signal) => jobs.run(async () => catalog.getPreview(id, prId), signal),
		getDiagram: (prId, id, signal) => jobs.run(async () => catalog.getDiagram(id, prId), signal),
		validateLocation: (prId, location, signal) => review.validateLocation(prId, location, signal),
		drafts,
	};
	const generated = new Map<string, GeneratedScenario>();
	const generatedKey = (prId: string, id: string) => JSON.stringify([prId, id]);
	if (options.scenarioTargets) {
		const getTargets = options.scenarioTargets;
		ports.scenarioAuthoring = {
			getTargets: (prId, signal) =>
				jobs.run(async (active) => {
					const { pr } = sources.prepared(prId);
					const targets = await getTargets(pr, active);
					const inspected: ScenarioTarget[] = [];
					for (const target of targets) {
						if (target.location.revision !== "head")
							throw new Error("Scenario target must use the head");
						const source = await sources.location(pr, target.location, active);
						inspected.push(ScenarioTargetSchema.parse({ ...target, sourceText: source.content }));
					}
					return inspected;
				}, signal),
			saveGenerated: (raw, signal) =>
				jobs.run(async (active) => {
					const value = GeneratedScenarioSchema.parse(raw);
					const { pr } = sources.prepared(value.plan.pr.id);
					if (
						!sameRevision(pr, value.plan.pr) ||
						!isDeepStrictEqual(generateScenario(value.plan), value)
					)
						throw new Error("Generated scenario changed or belongs to another revision");
					for (const revision of ["base", "head"] as const) {
						const file = await sources.source(pr, revision, value.plan.modulePath, active);
						if (
							file.content?.split("\n").filter((line) => line.includes(value.plan.anchor))
								.length !== 1
						)
							throw new Error("Scenario anchor must resolve on both revisions");
					}
					active.throwIfAborted();
					const key = generatedKey(pr.id, value.plan.id);
					const existing = generated.get(key);
					if (existing && !isDeepStrictEqual(existing, value))
						throw new Error("Generated scenario ID conflict");
					generated.set(key, value);
				}, signal),
			getGenerated: (prId, id, signal) =>
				jobs.run(async () => {
					const value = generated.get(generatedKey(prId, id));
					if (!value) throw new Error("Generated scenario not found");
					sources.assertCurrent(value.plan.pr);
					return structuredClone(value);
				}, signal),
			saveTrace: (trace, signal) =>
				jobs.run(async (active) => {
					await catalog.saveScenario(trace, active);
				}, signal),
			runtime: {
				runGeneratedTest: (input) =>
					jobs.run(async (active) => {
						sources.assertCurrent(input.pr);
						const result = await options.getRuntime().scenarios.runGeneratedTest({
							...input,
							...sources.prepared(input.pr.id),
							signal: active,
						});
						active.throwIfAborted();
						return result;
					}, input.signal),
			},
		};
	}

	class ComposedAgentService extends AgentService {
		override start(raw: unknown) {
			const input = StartTurnSchema.parse(raw);
			return accounting.run(input.screenContext.prId, () => super.start(input));
		}
		override releaseSession(sessionId: string) {
			super.releaseSession(sessionId);
			options.screenContexts.release(sessionId);
		}
	}
	const service = new ComposedAgentService(client, ports);
	let disposal: Promise<void> | undefined;
	return {
		service,
		drafts,
		ports,
		catalog,
		review,
		usage,
		screenContexts: options.screenContexts,
		createRuntime: (runtimeOptions: RuntimeOptions) =>
			new CatalogRuntimeService(runtimeOptions, catalog, jobs),
		explainIntent: (input: Parameters<ReviewPreparation["explain"]>[0], signal?: AbortSignal) =>
			accounting.run(input.screenContext.prId, () => review.explain(input, signal)),
		dispose(): Promise<void> {
			disposal ??= (async () => {
				jobs.stop();
				await service.dispose();
				await jobs.drain();
				catalog.clear();
				review.clear();
				generated.clear();
				options.screenContexts.clear();
			})();
			return disposal;
		},
	};
}

export type AgentComposition = ReturnType<typeof createAgentComposition>;
