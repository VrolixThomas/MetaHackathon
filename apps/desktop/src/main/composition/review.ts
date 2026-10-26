import { createHash } from "node:crypto";
import {
	type CodeLocation,
	type Evidence,
	type PRPreparation,
	PRPreparationSchema,
	type PullRequest,
	type ScreenContext,
	type SourceFileRequest,
} from "../../shared/contracts";
import { findCodeContext } from "../agent/code-context";
import { explainIntent } from "../agent/intent";
import type { MetaClient } from "../agent/meta-client";
import { preparePullRequest } from "../agent/preparation";
import type { ScreenContextStore } from "../agent/screen-context";
import type { ArtifactCatalog } from "./catalog";
import { sourceExcerpts } from "./excerpts";
import type { MainJobs } from "./jobs";
import { type PinnedSources, isSeeded, sameRevision } from "./source";

export interface ReviewOptions {
	/** Main-only command policy. Never accept commands from the renderer or model. */
	buildCommand?: (pr: PullRequest) => { command: string; args: string[] } | undefined;
	/** A trusted reader may supply a retrieved, redacted author trail; absent means inferred only. */
	getIntentTrail?: (pr: PullRequest, signal: AbortSignal) => Promise<string | null>;
}

export class ReviewPreparation {
	private readonly preparations = new Map<string, PRPreparation>();
	constructor(
		private readonly sources: PinnedSources,
		private readonly catalog: ArtifactCatalog,
		private readonly jobs: MainJobs,
		private readonly client: MetaClient,
		private readonly screens: ScreenContextStore,
		private readonly options: ReviewOptions
	) {}

	prepare(prId: string, signal?: AbortSignal): Promise<PRPreparation> {
		return this.jobs.run(async (active) => {
			const { pr } = this.sources.prepared(prId);
			let prep = this.preparations.get(prId);
			if (!prep || !sameRevision(prep.pr, pr)) {
				const paths = await this.sources.getRuntime().changedFiles(prId);
				active.throwIfAborted();
				const files: {
					path: string;
					baseContent: string | null;
					headContent: string | null;
					evidence: Evidence;
				}[] = [];
				for (const path of paths) {
					const base = await this.sources.source(pr, "base", path, active);
					const head = await this.sources.source(pr, "head", path, active);
					if (base.content === null && head.content === null)
						throw new Error("Changed file is absent from both pinned revisions");
					files.push({
						path,
						baseContent: base.content,
						headContent: head.content,
						evidence: this.sources.evidence(pr, path, head.content === null ? "base" : "head"),
					});
				}
				const evidence: Evidence = isSeeded(pr)
					? {
							kind: "fixture",
							fixtureId: `seeded:${pr.id}`,
							label:
								"Seeded local PR: title, author and review metadata are illustrative. Source is pinned local Git; execution is reported separately.",
						}
					: this.sources.evidence(pr);
				prep = await preparePullRequest(
					{ pr, files, evidence },
					{
						runBuilds: async (pinned, buildSignal) => {
							const command = this.options.buildCommand?.(pinned);
							if (!command) throw new Error("No trusted build command configured");
							this.sources.assertCurrent(pinned);
							return this.jobs.run(
								(runSignal) =>
									this.sources.getRuntime().scenarios.runBuilds({
										...this.sources.prepared(pinned.id),
										...command,
										timeoutMs: 30_000,
										signal: runSignal,
									}),
								buildSignal
							);
						},
					},
					active
				);
				active.throwIfAborted();
				this.sources.assertCurrent(pr);
				const ordered = prep.files
					.map((entry) => files.find((file) => file.path === entry.path))
					.filter((file): file is (typeof files)[number] => file !== undefined);
				prep = PRPreparationSchema.parse({
					...prep,
					sourceContext: sourceExcerpts(pr, ordered, (path, revision) =>
						this.sources.evidence(pr, path, revision)
					),
					summary: `${prep.summary} Source context contains bounded verbatim prefixes; omitted ranges are not supplied.`,
				});
				this.preparations.set(prId, prep);
			}
			return PRPreparationSchema.parse({
				...prep,
				summary: `${prep.summary}\nExisting artifacts (lookup does not execute): ${JSON.stringify(this.catalog.available(prId))}`,
			});
		}, signal);
	}

	source(input: SourceFileRequest, signal?: AbortSignal) {
		return this.jobs.run(
			(active) =>
				this.sources.source(
					this.sources.prepared(input.prId).pr,
					input.revision,
					input.path,
					active
				),
			signal
		);
	}

	validateLocation(prId: string, location: CodeLocation, signal?: AbortSignal): Promise<boolean> {
		return this.jobs.run(async (active) => {
			try {
				await this.sources.location(this.sources.prepared(prId).pr, location, active);
				return true;
			} catch {
				active.throwIfAborted();
				return false;
			}
		}, signal);
	}

	/** Explicit model operation; deterministic preparation itself needs no credential. */
	explain(
		input: {
			requestId: string;
			sessionId: string;
			screenContext: ScreenContext;
			locations: CodeLocation[];
		},
		signal?: AbortSignal
	) {
		return this.jobs.run(async (active) => {
			const screen = this.screens.get(input.sessionId, input.screenContext);
			const { pr } = this.sources.prepared(screen.prId);
			const prep = await this.prepare(pr.id, active);
			const targets = [];
			for (const [index, location] of input.locations.entries()) {
				if (!prep.files.some((file) => file.path === location.path))
					throw new Error("Intent target is not a changed file");
				const source = await this.sources.location(pr, location, active);
				const excerpt = source.content
					?.split("\n")
					.slice(location.startLine - 1, location.endLine)
					.join("\n");
				if (!excerpt) throw new Error("Intent target has no source excerpt");
				const evidence = this.sources.evidence(pr, location.path, location.revision);
				if (evidence.kind !== "source") throw new Error("Expected inspected source evidence");
				targets.push({
					id: String(index),
					location,
					source: { kind: "code", url: evidence.url, excerpt, evidence },
				});
			}
			const trail = isSeeded(pr)
				? null
				: ((await this.options.getIntentTrail?.(pr, active)) ?? null);
			const latest = this.screens.get(input.sessionId, screen);
			if (latest.prId !== pr.id) throw new Error("Review changed before intent request");
			const whyNotes = await explainIntent(
				this.client,
				{ requestId: input.requestId, pr, screenContext: latest, trail, targets },
				active
			);
			active.throwIfAborted();
			this.sources.assertCurrent(pr);
			if (this.screens.get(input.sessionId, latest).sequence !== latest.sequence)
				throw new Error("Screen changed during intent request");
			// Seeded authored metadata remains illustrative; inferred code explanations retain their citations.
			const result = PRPreparationSchema.parse({ ...prep, whyNotes });
			this.preparations.set(pr.id, {
				...result,
				summary: result.summary.split("\nExisting artifacts")[0] ?? result.summary,
			});
			return result;
		}, signal);
	}

	codeContext(prId: string, changed: CodeLocation[], paths: string[], signal?: AbortSignal) {
		return this.jobs.run(async (active) => {
			const { pr } = this.sources.prepared(prId);
			const revision = changed[0]?.revision;
			if (!revision || changed.some((location) => location.revision !== revision))
				throw new Error("Choose one revision for code context");
			for (const location of changed) await this.sources.location(pr, location, active);
			const files = [];
			for (const path of new Set([...paths, ...changed.map((location) => location.path)])) {
				const file = await this.sources.source(pr, revision, path, active);
				if (file.content !== null) files.push({ path, source: file.content });
			}
			const result = findCodeContext({
				pr,
				revision,
				files,
				changed,
				evidence: this.sources.evidence(pr, undefined, revision),
			});
			// Agent helper's default ID only includes SHA; distinct inspections must not overwrite it.
			result.diagram.id = `context-${createHash("sha256")
				.update(JSON.stringify([pr, revision, files, changed]))
				.digest("hex")}`;
			// Repeated identical inspections reuse the original timestamp/evidence.
			try {
				result.diagram = this.catalog.getDiagram(result.diagram.id, pr.id);
			} catch {
				result.diagram = await this.catalog.saveDiagram(result.diagram, active);
			}
			return result;
		}, signal);
	}
	clear(): void {
		this.preparations.clear();
	}
}
