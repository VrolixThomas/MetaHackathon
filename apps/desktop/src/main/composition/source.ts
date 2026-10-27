import { pathToFileURL } from "node:url";
import {
	type CodeLocation,
	CodeLocationSchema,
	type Evidence,
	type PullRequest,
	PullRequestSchema,
	SourceFileRequestSchema,
	SourceFileSchema,
} from "../../shared/contracts";
import type { RuntimeService } from "../runtime/service";

export function sameRevision(a: PullRequest, b: PullRequest): boolean {
	return (
		a.id === b.id &&
		a.repository === b.repository &&
		a.number === b.number &&
		a.baseSha === b.baseSha &&
		a.headSha === b.headSha
	);
}

export function isSeeded(pr: PullRequest): boolean {
	return new URL(pr.url).hostname === "example.invalid";
}

/** All identities originate in runtime's prepared state, never renderer metadata. */
export class PinnedSources {
	constructor(readonly getRuntime: () => RuntimeService) {}

	prepared(prId: string) {
		const { pr: raw, worktrees } = this.getRuntime().getPrepared(prId);
		const pr = PullRequestSchema.parse(raw);
		if (pr.id !== prId || worktrees.base.sha !== pr.baseSha || worktrees.head.sha !== pr.headSha)
			throw new Error("Prepared repository identity changed");
		return { pr, worktrees };
	}

	assertCurrent(pr: PullRequest): void {
		if (!sameRevision(pr, this.prepared(pr.id).pr)) throw new Error("Prepared PR revision changed");
	}

	async source(pr: PullRequest, revision: "base" | "head", path: string, signal: AbortSignal) {
		signal.throwIfAborted();
		const request = SourceFileRequestSchema.parse({ prId: pr.id, revision, path });
		this.assertCurrent(pr);
		const source = SourceFileSchema.parse(
			await this.getRuntime().source(request.prId, revision, path)
		);
		signal.throwIfAborted();
		this.assertCurrent(pr);
		if (
			source.prId !== pr.id ||
			source.repository !== pr.repository ||
			source.path !== path ||
			source.revision !== revision ||
			source.commitSha !== (revision === "base" ? pr.baseSha : pr.headSha)
		)
			throw new Error("Source does not match the pinned request");
		return source;
	}

	async location(pr: PullRequest, raw: CodeLocation, signal: AbortSignal) {
		const location = CodeLocationSchema.parse(raw);
		if (
			location.repository !== pr.repository ||
			location.commitSha !== (location.revision === "base" ? pr.baseSha : pr.headSha)
		)
			throw new Error("Location does not match prepared PR");
		const source = await this.source(pr, location.revision, location.path, signal);
		if (source.content === null || location.endLine > source.content.split("\n").length)
			throw new Error("Location is outside committed source");
		return source;
	}

	/** Local Git objects are read sources, not a claim that seeded PR metadata was published. */
	evidence(pr: PullRequest, path?: string, revision: "base" | "head" = "head"): Evidence {
		const { worktrees } = this.prepared(pr.id);
		const url = pathToFileURL(worktrees.repositoryPath);
		url.hash = `${revision === "base" ? pr.baseSha : pr.headSha}${path ? `:${path}` : ""}`;
		return { kind: "source", url: url.href, retrievedAt: new Date().toISOString() };
	}
}
