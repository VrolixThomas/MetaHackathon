import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import {
	ConfirmCommentInputSchema,
	DraftedCommentSchema,
	PullRequestSchema,
} from "../../shared/contracts";
import type { ConfirmCommentInput, DraftedComment, PullRequest } from "../../shared/contracts";
import type { SubmissionLedger } from "../db/runtime-state";
import type { CredentialStore } from "./credentials";

const execFileAsync = promisify(execFile);
const remotePR = z.object({
	number: z.number().int().positive(),
	html_url: z.string().url(),
	title: z.string(),
	user: z.object({ login: z.string() }),
	base: z.object({ sha: z.string() }),
	head: z.object({ sha: z.string() }),
});
const component = (value: string) => {
	if (!/^[A-Za-z0-9_.-]+$/.test(value) || value === "." || value === "..")
		throw new Error("Invalid GitHub repository");
	return encodeURIComponent(value);
};
function repositoryPath(repository: string) {
	const parts = repository.split("/");
	if (parts.length !== 2) throw new Error("Expected owner/repository");
	return `/repos/${component(parts[0] ?? "")}/${component(parts[1] ?? "")}`;
}

export class GitHubClient {
	private readonly posts = new Map<
		string,
		{ signature: string; result: Promise<{ url: string; id: number }> }
	>();
	constructor(
		private readonly credentials: CredentialStore,
		private readonly transport: typeof fetch = fetch,
		private readonly ledger?: SubmissionLedger
	) {}

	async importGhToken() {
		let token: string | undefined;
		for (const executable of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
			try {
				const result = await execFileAsync(
					executable,
					["auth", "token", "--hostname", "github.com"],
					{ timeout: 10_000, maxBuffer: 32_768 }
				);
				token = result.stdout.trim();
				if (token) break;
			} catch {
				/* Never propagate subprocess errors containing tokens. */
			}
		}
		if (!token)
			throw new Error("No GitHub CLI token available; sign in with gh or save a token in Settings");
		await this.credentials.set("github", token);
		return this.account();
	}

	private async request(
		path: string,
		options: { method?: string; body?: unknown; signal?: AbortSignal } = {}
	): Promise<unknown> {
		const token = await this.credentials.get("github");
		if (!token) throw new Error("GitHub sign-in required");
		const signal = options.signal
			? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
			: AbortSignal.timeout(20_000);
		let response: Response;
		try {
			response = await this.transport(`https://api.github.com${path}`, {
				method: options.method ?? "GET",
				signal,
				redirect: "error",
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
					"Content-Type": "application/json",
				},
				...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
			});
		} catch {
			throw new Error(
				signal.aborted ? "GitHub request cancelled or timed out" : "GitHub request failed"
			);
		}
		if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
		return response.json();
	}

	async account() {
		return z
			.object({ login: z.string(), avatar_url: z.string().url() })
			.parse(await this.request("/user"));
	}

	async readPullRequest(
		repository: string,
		number: number,
		signal?: AbortSignal
	): Promise<PullRequest> {
		if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid PR number");
		const pr = remotePR.parse(
			await this.request(`${repositoryPath(repository)}/pulls/${number}`, { signal })
		);
		return PullRequestSchema.parse({
			id: `${repository}#${pr.number}`,
			repository,
			number: pr.number,
			url: pr.html_url,
			title: pr.title,
			author: pr.user.login,
			baseSha: pr.base.sha,
			headSha: pr.head.sha,
		});
	}

	async reviewRequests(signal?: AbortSignal): Promise<PullRequest[]> {
		const { login } = await this.account();
		const found: PullRequest[] = [];
		for (let page = 1; page <= 10; page++) {
			const query = encodeURIComponent(`is:pr is:open review-requested:${login}`);
			const result = z
				.object({ items: z.array(z.object({ number: z.number(), repository_url: z.string() })) })
				.parse(
					await this.request(`/search/issues?q=${query}&per_page=100&page=${page}`, { signal })
				);
			for (const item of result.items) {
				const url = new URL(item.repository_url);
				if (url.origin !== "https://api.github.com" || !url.pathname.startsWith("/repos/"))
					throw new Error("Invalid GitHub search result");
				found.push(await this.readPullRequest(url.pathname.slice(7), item.number, signal));
			}
			if (result.items.length < 100) break;
		}
		return found;
	}

	async files(pr: PullRequest, signal?: AbortSignal) {
		const files: {
			filename: string;
			status: string;
			additions: number;
			deletions: number;
			patch?: string;
		}[] = [];
		for (let page = 1; page <= 30; page++) {
			const batch = z
				.array(
					z.object({
						filename: z.string(),
						status: z.string(),
						additions: z.number(),
						deletions: z.number(),
						patch: z.string().optional(),
					})
				)
				.parse(
					await this.request(
						`${repositoryPath(pr.repository)}/pulls/${pr.number}/files?per_page=100&page=${page}`,
						{ signal }
					)
				);
			files.push(...batch);
			if (batch.length < 100) return files;
		}
		throw new Error("GitHub file list exceeds 3000-file API limit");
	}

	/** The agent supplies the current authoritative draft. The renderer cannot invent one. */
	postConfirmedComment(
		prInput: PullRequest,
		draftInput: DraftedComment,
		confirmationInput: ConfirmCommentInput
	) {
		const pr = PullRequestSchema.parse(prInput);
		const draft = DraftedCommentSchema.parse(draftInput);
		const confirmation = ConfirmCommentInputSchema.parse(confirmationInput);
		if (
			draft.prId !== pr.id ||
			draft.headSha !== pr.headSha ||
			confirmation.draftId !== draft.id ||
			confirmation.draftRevision !== draft.revision ||
			confirmation.headSha !== draft.headSha ||
			confirmation.body !== draft.body
		)
			throw new Error("Stale or mismatched comment confirmation");
		if (
			draft.location &&
			(draft.location.repository !== pr.repository ||
				draft.location.revision !== "head" ||
				draft.location.commitSha !== pr.headSha)
		)
			throw new Error("Comment location must match current head");
		const signature = createHash("sha256")
			.update(JSON.stringify({ pr, draft, confirmation }))
			.digest("hex");
		const previous = this.posts.get(confirmation.requestId);
		if (previous) {
			if (previous.signature !== signature)
				throw new Error("Confirmation request ID reused with different content");
			return previous.result;
		}
		const durableResult = this.ledger?.reserve(confirmation.requestId, signature);
		if (durableResult) return Promise.resolve(durableResult);
		const result = this.postOnce(pr, draft).then((posted) => {
			this.ledger?.complete(confirmation.requestId, posted);
			return posted;
		});
		// Keep failed/ambiguous submissions too: do not retry a possibly accepted network write automatically.
		this.posts.set(confirmation.requestId, { signature, result });
		return result;
	}

	private async postOnce(pr: PullRequest, draft: DraftedComment) {
		const current = await this.readPullRequest(pr.repository, pr.number);
		if (current.headSha !== draft.headSha)
			throw new Error("PR head changed; review the draft again");
		const path = `${repositoryPath(pr.repository)}/${draft.location ? `pulls/${pr.number}/comments` : `issues/${pr.number}/comments`}`;
		const body = draft.location
			? {
					body: draft.body,
					commit_id: pr.headSha,
					path: draft.location.path,
					line: draft.location.endLine,
					side: "RIGHT",
				}
			: { body: draft.body };
		const result = z
			.object({ id: z.number(), html_url: z.string().url() })
			.parse(await this.request(path, { method: "POST", body }));
		return { id: result.id, url: result.html_url };
	}
}

/** Poll sequentially; stop aborts an in-flight search and prevents late updates. */
export function pollReviewRequests(
	client: GitHubClient,
	onRequests: (prs: PullRequest[]) => Promise<void>,
	onError: (error: Error) => void,
	intervalMs = 60_000
) {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const poll = async () => {
		try {
			const prs = await client.reviewRequests(controller.signal);
			if (!controller.signal.aborted) await onRequests(prs);
		} catch (error) {
			if (!controller.signal.aborted)
				onError(error instanceof Error ? error : new Error("Review polling failed"));
		}
		if (!controller.signal.aborted) timer = setTimeout(poll, Math.max(10_000, intervalMs));
	};
	void poll();
	return () => {
		controller.abort();
		clearTimeout(timer);
	};
}
