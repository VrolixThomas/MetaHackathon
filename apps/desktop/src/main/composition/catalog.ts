import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
	type CodeLocation,
	type DiagramSpec,
	DiagramSpecSchema,
	type Preview,
	PreviewSchema,
	type PullRequest,
	ScenarioRunSchema,
	type ScenarioTrace,
	ScenarioTraceSchema,
} from "../../shared/contracts";
import { type PinnedSources, sameRevision } from "./source";

type Entry<T> = { pr: PullRequest; value: T };

export const CatalogSnapshotSchema = z.strictObject({
	scenarios: z.array(
		z.strictObject({
			id: z.string(),
			title: z.string(),
			base: z.strictObject({
				status: ScenarioRunSchema.shape.status,
				evidence: z.enum(["fixture", "execution"]),
			}),
			head: z.strictObject({
				status: ScenarioRunSchema.shape.status,
				evidence: z.enum(["fixture", "execution"]),
			}),
		})
	),
	previews: z.array(
		z.strictObject({
			id: z.string(),
			evidence: z.enum(["fixture", "execution"]),
			mode: z.enum(["phone", "desktop"]),
		})
	),
	diagrams: z.array(
		z.strictObject({
			id: z.string(),
			title: z.string(),
			evidence: z.enum(["fixture", "source", "execution"]),
		})
	),
});

/** One main-only catalog for both UI runtime actions and agent-generated artifacts. */
export class ArtifactCatalog {
	private readonly scenarios = new Map<string, Entry<ScenarioTrace>>();
	private readonly previews = new Map<string, Entry<Preview>>();
	private readonly diagrams = new Map<string, Entry<DiagramSpec>>();
	constructor(private readonly sources: PinnedSources) {}

	private async locations(pr: PullRequest, locations: CodeLocation[], signal: AbortSignal) {
		// One committed read per path/revision, including all line bounds on that file.
		const ranges = new Map<string, CodeLocation>();
		for (const location of locations) {
			if (
				location.repository !== pr.repository ||
				location.commitSha !== (location.revision === "base" ? pr.baseSha : pr.headSha)
			)
				throw new Error("Artifact location belongs to another revision");
			const key = JSON.stringify([location.revision, location.path]);
			const previous = ranges.get(key);
			if (!previous || previous.endLine < location.endLine) ranges.set(key, location);
		}
		for (const location of ranges.values()) await this.sources.location(pr, location, signal);
		signal.throwIfAborted();
		this.sources.assertCurrent(pr);
	}

	private put<T extends { id: string }>(map: Map<string, Entry<T>>, pr: PullRequest, value: T) {
		const previous = map.get(value.id);
		if (previous && (!sameRevision(previous.pr, pr) || !isDeepStrictEqual(previous.value, value)))
			throw new Error("Artifact ID already identifies a different result");
		map.set(value.id, { pr: structuredClone(pr), value: structuredClone(value) });
		return structuredClone(value);
	}

	async saveScenario(raw: ScenarioTrace, signal: AbortSignal) {
		const value = ScenarioTraceSchema.parse(raw);
		const { pr } = this.sources.prepared(value.prId);
		if (value.before.commitSha !== pr.baseSha || value.after.commitSha !== pr.headSha)
			throw new Error("Scenario belongs to another PR revision");
		await this.locations(
			pr,
			[...value.before.steps, ...value.after.steps].map((s) => s.location),
			signal
		);
		return this.put(this.scenarios, pr, value);
	}

	async savePreview(raw: Preview, signal: AbortSignal) {
		const value = PreviewSchema.parse(raw);
		const { pr } = this.sources.prepared(value.prId);
		if (value.commitSha !== (value.revision === "base" ? pr.baseSha : pr.headSha))
			throw new Error("Preview belongs to another PR revision");
		await this.locations(
			pr,
			value.markers.map((m) => m.location),
			signal
		);
		return this.put(this.previews, pr, value);
	}

	async saveDiagram(raw: DiagramSpec, signal: AbortSignal) {
		const value = DiagramSpecSchema.parse(raw);
		const { pr } = this.sources.prepared(value.prId);
		await this.locations(
			pr,
			value.nodes.map((n) => n.location),
			signal
		);
		return this.put(this.diagrams, pr, value);
	}

	private get<T>(map: Map<string, Entry<T>>, id: string, prId?: string): T {
		const entry = map.get(id);
		if (!entry || (prId !== undefined && entry.pr.id !== prId))
			throw new Error("Artifact not found");
		this.sources.assertCurrent(entry.pr);
		return structuredClone(entry.value);
	}
	getScenario(id: string, prId?: string) {
		return this.get(this.scenarios, id, prId);
	}
	getPreview(id: string, prId?: string) {
		return this.get(this.previews, id, prId);
	}
	getDiagram(id: string, prId?: string) {
		return this.get(this.diagrams, id, prId);
	}
	removePreview(id: string): void {
		this.previews.delete(id);
	}

	available(prId: string) {
		const { pr } = this.sources.prepared(prId);
		const matching = <T extends { id: string }>(map: Map<string, Entry<T>>) =>
			[...map.values()].filter((e) => sameRevision(e.pr, pr)).map((e) => e.value);
		return {
			scenarios: matching(this.scenarios).map((s) => ({
				id: s.id,
				title: s.title,
				base: { status: s.before.status, evidence: s.before.evidence.kind },
				head: { status: s.after.status, evidence: s.after.evidence.kind },
			})),
			previews: matching(this.previews).map((p) => ({
				id: p.id,
				evidence: p.evidence.kind,
				mode: p.viewport.mode,
			})),
			diagrams: matching(this.diagrams).map((d) => ({
				id: d.id,
				title: d.title,
				evidence: d.evidence.kind,
			})),
		};
	}
	clear(): void {
		this.scenarios.clear();
		this.previews.clear();
		this.diagrams.clear();
	}
}
