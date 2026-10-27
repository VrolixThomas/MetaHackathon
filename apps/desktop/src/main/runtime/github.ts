import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import {
	ConfirmCommentInputSchema,
	ConversationPRContextSchema,
	DraftedCommentSchema,
	GitHubRepositorySchema,
	PullRequestSchema,
	RepositoryPathSchema,
} from "../../shared/contracts";
import type {
	ConfirmCommentInput,
	ConversationPRContext,
	DraftedComment,
	PullRequest,
} from "../../shared/contracts";
import type { SubmissionLedger } from "../db/runtime-state";
import type { CredentialAccess } from "./credentials";

const execFileAsync = promisify(execFile);
const remotePR = z.object({
	number: z.number().int().positive(),
	html_url: z.string().url().max(2048),
	title: z.string().min(1).max(1024),
	user: z.object({ login: z.string().min(1).max(100) }),
	base: z.object({ sha: z.string() }),
	head: z.object({ sha: z.string() }),
});
const contextPR = remotePR.extend({
	body: z.string().nullable(),
	changed_files: z.int().nonnegative(),
});
const repositoryRef = z.object({ full_name: GitHubRepositorySchema.max(240) });
const listedPR = remotePR.extend({
	state: z.literal("open"),
	base: z.object({ sha: z.string(), repo: repositoryRef }),
	head: z.object({ sha: z.string(), repo: repositoryRef.nullable() }),
});
const remoteFile = z.object({
	filename: RepositoryPathSchema.max(4096),
	status: z.string().max(32),
	additions: z.int().nonnegative(),
	deletions: z.int().nonnegative(),
	patch: z.string().optional(),
});
const MAX_CONTEXT_CHARS = 120_000;
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

function parsePRId(prId: string) {
	const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(prId);
	const number = Number(match?.[2]);
	if (!match || prId.length > 240 || !Number.isSafeInteger(number))
		throw new Error("Expected a GitHub PR identifier: owner/repository#number");
	const repository = match[1] as string;
	repositoryPath(repository);
	return { repository, number };
}
export const GitHubPRIdSchema = z
	.string()
	.max(240)
	.refine((value) => {
		try {
			parsePRId(value);
			return true;
		} catch {
			return false;
		}
	}, "Expected a GitHub PR identifier: owner/repository#number");

function pullRequest(
	repository: string,
	number: number,
	pr: z.infer<typeof remotePR>
): PullRequest {
	if (pr.number !== number) throw new Error("GitHub returned a different PR");
	return PullRequestSchema.parse({
		id: `${repository}#${number}`,
		repository,
		number,
		url: pr.html_url,
		title: pr.title,
		author: pr.user.login,
		baseSha: pr.base.sha,
		headSha: pr.head.sha,
	});
}

/** Read only an existing CLI session; never open an interactive subprocess or expose its output. */
async function readGhToken(): Promise<string> {
	for (const executable of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
		try {
			const result = await execFileAsync(
				executable,
				["auth", "token", "--hostname", "github.com"],
				{ timeout: 10_000, maxBuffer: 32_768 }
			);
			if (result.stdout.trim()) return result.stdout.trim();
		} catch {
			/* Subprocess errors may contain credentials; do not propagate them. */
		}
	}
	throw new Error("GitHub CLI session unavailable");
}

export class GitHubClient {
	private readonly posts = new Map<
		string,
		{ signature: string; result: Promise<{ url: string; id: number }> }
	>();
	constructor(
		private readonly credentials: CredentialAccess,
		private readonly transport: typeof fetch = fetch,
		private readonly ledger?: SubmissionLedger,
		private readonly ghTokenReader: () => Promise<string> = readGhToken
	) {}

	async importGhToken() {
		let token: string;
		try {
			token = (await this.ghTokenReader()).trim();
			if (!token || token.length > 16_384) throw new Error("Invalid token");
		} catch {
			throw new Error(
				"No GitHub CLI session found. Run gh auth login --hostname github.com, then connect again, or configure GITHUB_TOKEN in the app .env file."
			);
		}
		await this.credentials.set("github", token);
		return this.account();
	}

	private async request(
		path: string,
		options: { method?: string; body?: unknown; signal?: AbortSignal } = {}
	): Promise<unknown> {
		const token = await this.credentials.get("github");
		if (!token)
			throw new Error(
				"GitHub sign-in required. Connect your GitHub CLI session or configure GITHUB_TOKEN in the app .env file."
			);
		const signal = options.signal
			? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
			: AbortSignal.timeout(20_000);
		if (signal.aborted) throw new Error("GitHub request cancelled before dispatch");
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
		if (!response.ok) {
			if (response.status === 401)
				throw new Error(
					"GitHub session expired or invalid. Run gh auth login --hostname github.com, then connect again."
				);
			if (response.status === 403 || response.status === 429)
				throw new Error(
					"GitHub access denied or rate-limited. Check repository access and organization SSO, or retry after the rate limit resets."
				);
			if (response.status === 404)
				throw new Error(
					"GitHub resource not found or inaccessible. Check the repository, PR number and account access."
				);
			throw new Error(`GitHub returned HTTP ${response.status}`);
		}
		if (signal.aborted) throw new Error("GitHub request cancelled before completion");
		let data: unknown;
		try {
			data = await response.json();
		} catch {
			throw new Error("GitHub returned an invalid JSON response");
		}
		if (signal.aborted) throw new Error("GitHub request cancelled before completion");
		return data;
	}

	async account(signal?: AbortSignal) {
		return z
			.object({ login: z.string(), avatar_url: z.string().url() })
			.parse(await this.request("/user", { signal }));
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
		return pullRequest(repository, number, pr);
	}

	/** Repository inbox: at most two 100-item pages, using each PR's actual base/fork SHAs. */
	async openPullRequests(repositoryInput: string, signal?: AbortSignal): Promise<PullRequest[]> {
		const repository = GitHubRepositorySchema.max(240).parse(repositoryInput);
		const found = new Map<number, PullRequest>();
		for (let page = 1; page <= 2; page++) {
			const batch = z
				.array(listedPR)
				.max(100)
				.parse(
					await this.request(
						`${repositoryPath(repository)}/pulls?state=open&per_page=100&page=${page}&sort=updated&direction=desc`,
						{ signal }
					)
				);
			for (const pr of batch) {
				if (pr.base.repo.full_name.toLowerCase() !== repository.toLowerCase())
					throw new Error("GitHub returned a PR for another repository");
				if (!found.has(pr.number)) found.set(pr.number, pullRequest(repository, pr.number, pr));
			}
			if (batch.length < 100) break;
		}
		return [...found.values()];
	}

	/** Bounded HTTP-only context. Recheck both SHAs so a moving PR cannot mix revisions. */
	async prContext(prId: string, signal?: AbortSignal): Promise<ConversationPRContext> {
		const { repository, number } = parsePRId(prId);
		const path = `${repositoryPath(repository)}/pulls/${number}`;
		const metadata = contextPR.parse(await this.request(path, { signal }));
		const pr = pullRequest(repository, number, metadata);
		const batch = z
			.array(remoteFile)
			.max(100)
			.parse(await this.request(`${path}/files?per_page=100&page=1`, { signal }));
		const description = metadata.body?.slice(0, 32_000) ?? "";
		let remaining = MAX_CONTEXT_CHARS - description.length;
		let truncated =
			(metadata.body?.length ?? 0) > description.length || metadata.changed_files > batch.length;
		const files: ConversationPRContext["files"] = [];
		for (const file of batch) {
			const size = file.filename.length + file.status.length;
			if (size > remaining) {
				truncated = true;
				break;
			}
			remaining -= size;
			const patch = file.patch?.slice(0, Math.min(20_000, remaining));
			if (patch !== undefined) remaining -= patch.length;
			if (
				(file.patch !== undefined && patch?.length !== file.patch.length) ||
				(file.patch === undefined && file.additions + file.deletions > 0)
			)
				truncated = true;
			files.push({
				path: file.filename,
				status: file.status,
				additions: file.additions,
				deletions: file.deletions,
				...(patch === undefined ? {} : { patch }),
			});
		}
		const current = await this.readPullRequest(repository, number, signal);
		if (current.baseSha !== pr.baseSha || current.headSha !== pr.headSha)
			throw new Error("PR revision changed while reading context. Reload the pull request.");
		return ConversationPRContextSchema.parse({ pr, description, files, truncated });
	}

	async reviewRequests(signal?: AbortSignal): Promise<PullRequest[]> {
		const { login } = await this.account(signal);
		if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error("Invalid GitHub account login");
		const found: PullRequest[] = [];
		const seen = new Set<string>();
		for (const scope of ["review-requested", "author"]) {
			for (let page = 1; page <= 10; page++) {
				const query = encodeURIComponent(`is:pr is:open ${scope}:${login}`);
				const result = z
					.object({ items: z.array(z.object({ number: z.number(), repository_url: z.string() })) })
					.parse(
						await this.request(`/search/issues?q=${query}&per_page=100&page=${page}`, { signal })
					);
				for (const item of result.items) {
					const url = new URL(item.repository_url);
					if (url.origin !== "https://api.github.com" || !url.pathname.startsWith("/repos/"))
						throw new Error("Invalid GitHub search result");
					const repository = url.pathname.slice(7);
					const key = `${repository.toLowerCase()}#${item.number}`;
					if (!seen.has(key)) {
						seen.add(key);
						found.push(await this.readPullRequest(repository, item.number, signal));
					}
				}
				if (result.items.length < 100) break;
			}
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

	/** Author intent and discussion remain source evidence; model inference must be labeled separately. */
	async discussion(pr: PullRequest, signal?: AbortSignal) {
		const pull = z
			.object({ body: z.string().nullable(), html_url: z.string().url() })
			.parse(await this.request(`${repositoryPath(pr.repository)}/pulls/${pr.number}`, { signal }));
		const comments: { id: number; body: string; html_url: string; user: { login: string } }[] = [];
		for (let page = 1; page <= 10; page++) {
			const batch = z
				.array(
					z.object({
						id: z.number(),
						body: z.string(),
						html_url: z.string().url(),
						user: z.object({ login: z.string() }),
					})
				)
				.parse(
					await this.request(
						`${repositoryPath(pr.repository)}/issues/${pr.number}/comments?per_page=100&page=${page}`,
						{ signal }
					)
				);
			comments.push(...batch);
			if (batch.length < 100)
				return {
					description: pull.body ?? "",
					url: pull.html_url,
					comments,
					retrievedAt: new Date().toISOString(),
				};
		}
		throw new Error("PR discussion exceeds the bounded comment read limit");
	}

	/** The agent supplies the current authoritative draft. The renderer cannot invent one. */
	postConfirmedComment(
		prInput: PullRequest,
		draftInput: DraftedComment,
		confirmationInput: ConfirmCommentInput,
		signal?: AbortSignal
	) {
		if (signal?.aborted) throw new Error("GitHub submission cancelled before dispatch");
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
		const result = this.postOnce(pr, draft, signal).then((posted) => {
			this.ledger?.complete(confirmation.requestId, posted);
			return posted;
		});
		// Keep failed/ambiguous submissions too: do not retry a possibly accepted network write automatically.
		this.posts.set(confirmation.requestId, { signature, result });
		return result;
	}

	private async postOnce(pr: PullRequest, draft: DraftedComment, signal?: AbortSignal) {
		const current = await this.readPullRequest(pr.repository, pr.number, signal);
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
			.parse(await this.request(path, { method: "POST", body, signal }));
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
