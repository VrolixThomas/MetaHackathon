import type { ConversationTurnInput } from "../../shared/contracts";
import {
	type ConversationTeamPorts,
	type ReviewedFixShareIntent,
	explicitReviewedFixShareRequested,
} from "../agent/team-tools";

const key = (turn: ConversationTurnInput) =>
	JSON.stringify([turn.sessionId, turn.turnId, turn.generation, turn.requestId]);
/** Snapshots permission at real ingress, before a model can navigate to a different candidate. */
export class TeamShareIntentRegistry {
	private intents = new Map<
		string,
		{ sessionId: string; value: Promise<ReviewedFixShareIntent | null> }
	>();
	constructor(
		private readonly ports: Pick<ConversationTeamPorts, "observe" | "detail" | "status">
	) {}
	capture(input: ConversationTurnInput) {
		this.clear(input.sessionId);
		if (!explicitReviewedFixShareRequested(input.text)) return;
		const turn = structuredClone(input);
		const value = this.read(turn).catch(() => null);
		this.intents.set(key(turn), { sessionId: turn.sessionId, value });
		if (this.intents.size > 100) this.intents.delete(this.intents.keys().next().value ?? "");
	}
	async get(turn: ConversationTurnInput) {
		return (await this.intents.get(key(turn))?.value) ?? null;
	}
	clear(sessionId?: string) {
		for (const [id, entry] of this.intents)
			if (!sessionId || entry.sessionId === sessionId) this.intents.delete(id);
	}
	private async read(turn: ConversationTurnInput): Promise<ReviewedFixShareIntent | null> {
		const initial = turn.workspace;
		const canvas = initial?.canvases.find((c) => c.id === initial.primaryId);
		if (!initial || canvas?.kind !== "center" || canvas.section !== "fixes" || !canvas.fixSource)
			return null;
		const source = canvas.fixSource;
		if (!source.headSha) return null;
		const signal = AbortSignal.timeout(15000);
		const observed = await this.ports.observe(turn.sessionId, signal);
		const visible = observed.workspace?.workspace;
		if (
			!visible ||
			(visible.contentSequence ?? visible.sequence) !==
				(initial.contentSequence ?? initial.sequence) ||
			!observed.pr
		)
			return null;
		const detail = await this.ports.detail(source.id, signal);
		const fix = detail.fix;
		const status = await this.ports.status();
		if (
			fix.phase !== "ready" ||
			!fix.reviewedAt ||
			fix.headSha !== source.headSha ||
			fix.baseSha !== source.baseSha ||
			!status.userId ||
			!status.canShare ||
			status.connection !== "connected"
		)
			return null;
		const scopes = status.scopes.filter((s) => s.repository === fix.pr.repository);
		if (
			scopes.length !== 1 ||
			!scopes[0] ||
			observed.pr.id !== fix.pr.id ||
			observed.pr.headSha !== fix.pr.headSha
		)
			return null;
		const after = await this.ports.observe(turn.sessionId, signal);
		const current = after.workspace?.workspace;
		const selected = current?.canvases.find((c) => c.id === current.primaryId);
		if (
			!current ||
			after.accountKey !== observed.accountKey ||
			(current.contentSequence ?? current.sequence) !==
				(initial.contentSequence ?? initial.sequence) ||
			selected?.kind !== "center" ||
			selected.fixSource?.id !== source.id ||
			selected.fixSource.headSha !== source.headSha
		)
			return null;
		return {
			candidateId: fix.id,
			baseSha: fix.baseSha,
			headSha: source.headSha,
			reviewedAt: fix.reviewedAt,
			pr: fix.pr,
			accountKey: observed.accountKey,
			teamUserId: status.userId,
			teamScope: scopes[0],
		};
	}
}
