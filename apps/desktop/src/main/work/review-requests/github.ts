import { z } from "zod";
import {
	Login,
	PRSchema,
	ReviewRequestError,
	type ReviewRequestPR,
	type ReviewRequestProvider,
} from "./types";
/** Root supplies a current account-fenced token. Never log HTTP bodies/errors. */
export class GitHubReviewRequestProvider implements ReviewRequestProvider {
	constructor(
		private readonly token: (signal: AbortSignal) => Promise<string>,
		private readonly transport: typeof fetch = fetch
	) {}
	private async call(path: string, signal: AbortSignal, body?: unknown) {
		try {
			const token = await this.token(signal);
			signal.throwIfAborted();
			const response = await this.transport(`https://api.github.com${path}`, {
				method: body === undefined ? "GET" : "POST",
				signal,
				redirect: "error",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"Content-Type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			if (!response.ok) throw new Error("HTTP failure");
			return await response.json();
		} catch {
			throw new ReviewRequestError(body === undefined ? "unavailable" : "unknown");
		}
	}
	private path(repository: string) {
		if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new ReviewRequestError("denied");
		return `/repos/${repository}`;
	}
	private parse(repository: string, raw: unknown) {
		const data = z
			.object({
				number: z.number(),
				node_id: z.string(),
				html_url: z.string(),
				state: z.string(),
				draft: z.boolean(),
				user: z.object({ login: Login }),
				head: z.object({ sha: z.string(), repo: z.object({ full_name: z.string() }) }),
				base: z.object({ repo: z.object({ full_name: z.string() }) }),
				requested_reviewers: z.array(z.object({ login: Login })),
			})
			.parse(raw);
		if (
			data.base.repo.full_name.toLowerCase() !== repository.toLowerCase() ||
			data.head.repo.full_name.toLowerCase() !== repository.toLowerCase()
		)
			throw new ReviewRequestError("changed");
		return PRSchema.parse({
			number: data.number,
			nodeId: data.node_id,
			url: data.html_url,
			repository,
			headSha: data.head.sha,
			author: data.user.login,
			draft: data.draft,
			open: data.state === "open",
			reviewers: data.requested_reviewers.map((r) => r.login),
		});
	}
	async read(repository: string, number: number, signal: AbortSignal) {
		return this.parse(
			repository,
			await this.call(`${this.path(repository)}/pulls/${number}`, signal)
		);
	}
	async canReview(repository: string, login: string, signal: AbortSignal) {
		Login.parse(login);
		const data = z
			.object({ permission: z.string(), user: z.object({ login: Login }) })
			.parse(
				await this.call(
					`${this.path(repository)}/collaborators/${encodeURIComponent(login)}/permission`,
					signal
				)
			);
		return (
			data.user.login.toLowerCase() === login.toLowerCase() &&
			["admin", "maintain", "write"].includes(data.permission)
		);
	}
	async ready(pr: ReviewRequestPR, signal: AbortSignal) {
		const data = z
			.object({
				data: z.object({
					markPullRequestReadyForReview: z.object({
						pullRequest: z.object({ id: z.string(), isDraft: z.literal(false) }),
					}),
				}),
				errors: z.array(z.unknown()).optional(),
			})
			.parse(
				await this.call("/graphql", signal, {
					query:
						"mutation Ready($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id isDraft } } }",
					variables: { id: pr.nodeId },
				})
			);
		if (data.errors?.length || data.data.markPullRequestReadyForReview.pullRequest.id !== pr.nodeId)
			throw new ReviewRequestError("unknown");
	}
	async request(pr: ReviewRequestPR, reviewers: string[], signal: AbortSignal) {
		return this.parse(
			pr.repository,
			await this.call(
				`${this.path(pr.repository)}/pulls/${pr.number}/requested_reviewers`,
				signal,
				{ reviewers, team_reviewers: [] }
			)
		);
	}
}
