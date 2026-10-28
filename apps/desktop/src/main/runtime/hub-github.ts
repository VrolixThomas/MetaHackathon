import { z } from "zod";
import {
	CommitShaSchema,
	GitHubRepositorySchema,
	type PullRequest,
	type PullRequestFeedback,
	PullRequestFeedbackSchema,
	PullRequestSchema,
	type RepositoryChoice,
	RepositoryChoiceSchema,
	RepositoryPathSchema,
	type ReviewQueueItem,
	ReviewQueueItemSchema,
	ReviewSourceSchema,
} from "../../shared/contracts";

const MAX_PAGE_ITEMS = 100;
const MAX_PAGES = 5;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
type ReviewSource = z.infer<typeof ReviewSourceSchema>;
class GitHubHttpError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}
const repositoryName = GitHubRepositorySchema.max(240);
const loginSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9-]+(?:\[bot\])?$/);
const accountSchema = z.object({
	login: loginSchema,
	name: z.string().max(200).nullable().optional(),
});
const repositorySchema = z.object({
	full_name: repositoryName,
	default_branch: z.string().min(1).max(200),
	private: z.boolean(),
});
const branchSchema = z.object({ sha: CommitShaSchema, ref: z.string().max(200) });
const pullSchema = z.object({
	number: z.int().positive(),
	html_url: z.url().max(2048),
	title: z.string().min(1).max(1024),
	user: z.object({ login: loginSchema }),
	base: branchSchema.extend({ repo: z.object({ full_name: repositoryName }) }),
	head: branchSchema,
	state: z.enum(["open", "closed"]),
	draft: z.boolean(),
	updated_at: z.iso.datetime(),
});
const userSchema = z.object({ login: loginSchema }).nullable();
const commentSchema = z.object({
	id: z.int().positive(),
	body: z.string().max(12000),
	user: userSchema,
	html_url: z.url().max(2048),
	created_at: z.iso.datetime(),
	updated_at: z.iso.datetime(),
});
const inlineSchema = commentSchema.extend({
	path: RepositoryPathSchema.max(4096),
	line: z.int().positive().nullable(),
	original_line: z.int().positive().nullable(),
	side: z.enum(["LEFT", "RIGHT"]).optional(),
	start_line: z.int().positive().nullable().optional(),
	original_start_line: z.int().positive().nullable().optional(),
	commit_id: CommitShaSchema,
	original_commit_id: CommitShaSchema,
});
const reviewSchema = z.object({
	id: z.int().positive(),
	body: z.string().max(12000),
	user: userSchema,
	html_url: z.url().max(2048),
	submitted_at: z.iso.datetime().nullable(),
	state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
	commit_id: CommitShaSchema,
});
const searchSchema = z.object({
	total_count: z.int().nonnegative(),
	incomplete_results: z.boolean(),
	items: z
		.array(
			z.object({
				number: z.int().positive(),
				repository_url: z.url(),
				pull_request: z.object({ url: z.url() }),
			})
		)
		.max(MAX_PAGE_ITEMS),
});

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) throw new Error("GitHub returned invalid or oversized data");
	return result.data;
}
function repoPath(repository: string): string {
	return `/repos/${repositoryName.parse(repository).split("/").map(encodeURIComponent).join("/")}`;
}
function parsePR(prId: string) {
	const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(prId);
	const number = Number(match?.[2]);
	if (!match || prId.length > 260 || !Number.isSafeInteger(number))
		throw new Error("Expected a GitHub PR identifier: owner/repository#number");
	const repository = repositoryName.parse(match[1]);
	return { repository, number };
}
function pullRequest(repository: string, remote: z.infer<typeof pullSchema>): PullRequest {
	if (remote.base.repo.full_name.toLowerCase() !== repository.toLowerCase())
		throw new Error("GitHub returned a PR from another repository");
	return parsed(PullRequestSchema, {
		id: `${repository}#${remote.number}`,
		repository,
		number: remote.number,
		url: remote.html_url,
		title: remote.title,
		author: remote.user.login,
		baseSha: remote.base.sha,
		headSha: remote.head.sha,
	});
}
function operationSignal(signal?: AbortSignal): AbortSignal {
	return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]);
}

/** Main-process credentials and transport are injected; never imports CLI auth or swarm runtime. */
export class HubGitHubClient {
	private readonly transport: typeof fetch;
	private readonly inFlight = new Set<Promise<void>>();
	private waiting = 0;
	constructor(
		private readonly options: {
			getToken: () => Promise<string | undefined>;
			fetch?: typeof fetch;
		}
	) {
		this.transport = options.fetch ?? fetch;
	}

	private async slot(signal: AbortSignal): Promise<() => void> {
		if (this.waiting >= 64) throw new Error("GitHub request queue is full; retry later");
		this.waiting++;
		let onAbort: () => void = () => {};
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("GitHub request cancelled or timed out"));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			while (this.inFlight.size >= 4) {
				if (signal.aborted) throw new Error("GitHub request cancelled or timed out");
				await Promise.race([...this.inFlight, aborted]);
			}
			if (signal.aborted) throw new Error("GitHub request cancelled or timed out");
			let release = () => {};
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			this.inFlight.add(pending);
			return () => {
				this.inFlight.delete(pending);
				release();
			};
		} finally {
			this.waiting--;
			signal.removeEventListener("abort", onAbort);
		}
	}

	/** Mirrors runtime/github.ts: fixed host/version, no redirects, finite timeout, sanitized errors. */
	private async request(path: string, signal?: AbortSignal, body?: unknown) {
		const boundedSignal = AbortSignal.any([
			...(signal ? [signal] : []),
			AbortSignal.timeout(20_000),
		]);
		let token: string | undefined;
		try {
			token = (await this.options.getToken())?.trim();
		} catch {
			throw new Error("GitHub credentials unavailable");
		}
		if (!token || token.length > 16384 || /[\r\n]/.test(token))
			throw new Error(
				"GitHub sign-in required. Connect GitHub or configure GITHUB_TOKEN in the app .env file."
			);
		const release = await this.slot(boundedSignal);
		try {
			let response: Response;
			try {
				response = await this.transport(`https://api.github.com${path}`, {
					method: body === undefined ? "GET" : "POST",
					signal: boundedSignal,
					redirect: "error",
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${token}`,
						"X-GitHub-Api-Version": "2022-11-28",
						"Content-Type": "application/json",
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
			} catch {
				throw new Error(
					boundedSignal.aborted ? "GitHub request cancelled or timed out" : "GitHub request failed"
				);
			}
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				if (response.status === 401)
					throw new Error("GitHub session expired or invalid. Reconnect GitHub.");
				if (response.status === 403 || response.status === 429)
					throw new Error(
						"GitHub access denied or rate-limited. Check repository access and organization SSO, or retry later."
					);
				if (response.status === 404)
					throw new GitHubHttpError(404, "GitHub resource not found or inaccessible.");
				throw new Error(`GitHub returned HTTP ${response.status}`);
			}
			if (!response.body) throw new Error("GitHub returned an empty response");
			const reader = response.body.getReader();
			const cancel = () => {
				void reader.cancel().catch(() => undefined);
			};
			boundedSignal.addEventListener("abort", cancel, { once: true });
			try {
				const chunks: Uint8Array[] = [];
				let size = 0;
				while (true) {
					if (boundedSignal.aborted) throw new Error("GitHub request cancelled or timed out");
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > MAX_RESPONSE_BYTES)
						throw new Error("GitHub response exceeds the bounded read limit");
					chunks.push(value);
				}
				if (boundedSignal.aborted) throw new Error("GitHub request cancelled or timed out");
				return {
					data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
					link: response.headers.get("link"),
				};
			} catch (error) {
				if (boundedSignal.aborted) throw new Error("GitHub request cancelled or timed out");
				if (
					error instanceof Error &&
					/^(GitHub request cancelled|GitHub response exceeds)/.test(error.message)
				)
					throw error;
				throw new Error("GitHub returned an unreadable JSON response");
			} finally {
				boundedSignal.removeEventListener("abort", cancel);
				cancel();
				reader.releaseLock();
			}
		} finally {
			release();
		}
	}

	async account(signal?: AbortSignal): Promise<{ login: string; name?: string | null }> {
		return parsed(accountSchema, (await this.request("/user", signal)).data);
	}
	async repositories(signal?: AbortSignal): Promise<RepositoryChoice[]> {
		const rows = await this.pages(
			"/user/repos?affiliation=owner,collaborator,organization_member&sort=updated",
			repositorySchema,
			operationSignal(signal)
		);
		const choices = rows.map((row) => this.choice(row));
		return [
			...new Map(choices.map((choice) => [choice.repository.toLowerCase(), choice])).values(),
		];
	}
	async repository(repository: string, signal?: AbortSignal): Promise<RepositoryChoice> {
		return this.choice(
			parsed(repositorySchema, (await this.request(repoPath(repository), signal)).data)
		);
	}
	private choice(row: z.infer<typeof repositorySchema>): RepositoryChoice {
		return parsed(RepositoryChoiceSchema, {
			repository: row.full_name,
			defaultBranch: row.default_branch,
			private: row.private,
		});
	}
	private async pages<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T[]> {
		const result: T[] = [];
		for (let page = 1; page <= MAX_PAGES; page++) {
			const response = await this.request(
				`${path}${path.includes("?") ? "&" : "?"}per_page=${MAX_PAGE_ITEMS}&page=${page}`,
				signal
			);
			const batch = parsed(z.array(schema).max(MAX_PAGE_ITEMS), response.data);
			result.push(...batch);
			const hasNext = response.link !== null && /;\s*rel="next"/.test(response.link);
			if (!hasNext && batch.length < MAX_PAGE_ITEMS) return result;
			// A full page without Link is ambiguous. Probe only within the configured bound.
			if (!hasNext && response.link !== null) return result;
		}
		throw new Error("GitHub list exceeds the bounded 500-item read limit; narrow the scope");
	}
	private async search(
		repository: string,
		qualifier: string,
		signal: AbortSignal
	): Promise<number[]> {
		const result = new Set<number>();
		let total = 0;
		for (let page = 1; page <= MAX_PAGES; page++) {
			const q = encodeURIComponent(`repo:${repository} is:pr is:open ${qualifier}`);
			const data = parsed(
				searchSchema,
				(
					await this.request(
						`/search/issues?q=${q}&sort=updated&order=desc&per_page=100&page=${page}`,
						signal
					)
				).data
			);
			if (data.incomplete_results || data.total_count > MAX_PAGES * MAX_PAGE_ITEMS)
				throw new Error(
					"GitHub review search is incomplete or exceeds the bounded 500-item read limit"
				);
			if (page > 1 && data.total_count !== total)
				throw new Error("GitHub review search changed during pagination; refresh again");
			total = data.total_count;
			for (const item of data.items) {
				if (
					item.repository_url.toLowerCase() !==
						`https://api.github.com${repoPath(repository)}`.toLowerCase() ||
					item.pull_request.url.toLowerCase() !==
						`https://api.github.com${repoPath(repository)}/pulls/${item.number}`.toLowerCase()
				)
					throw new Error("GitHub returned a search result from another repository");
				result.add(item.number);
			}
			if (result.size === total) return [...result];
			if (data.items.length < MAX_PAGE_ITEMS) break;
		}
		throw new Error("GitHub review search returned an incomplete page; refresh again");
	}
	async reviews(repositoryInput: string, signal?: AbortSignal): Promise<ReviewQueueItem[]> {
		const boundedSignal = operationSignal(signal);
		const { repository } = await this.repository(repositoryInput, boundedSignal);
		const { login } = await this.account(boundedSignal);
		if (!/^[A-Za-z0-9-]+$/.test(login))
			throw new Error("GitHub viewer login cannot be used for review search");
		// GitHub documents review-requested:USER as including requests to the viewer's teams.
		// https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests#search-by-pull-request-review-status-and-reviewer
		const incoming = await this.search(repository, `review-requested:${login}`, boundedSignal);
		const own = await this.search(repository, `author:${login}`, boundedSignal);
		const ownNumbers = new Set(own);
		const items: ReviewQueueItem[] = [];
		for (const number of new Set([...incoming, ...own])) {
			const remote = parsed(
				pullSchema,
				(await this.request(`${repoPath(repository)}/pulls/${number}`, boundedSignal)).data
			);
			if (remote.number !== number) throw new Error("GitHub returned a different PR");
			if (remote.state !== "open") continue; // Search can lag an actual close.
			const pr = pullRequest(repository, remote);
			const isOwn = pr.author.toLowerCase() === login.toLowerCase();
			if (ownNumbers.has(number) && !isOwn)
				throw new Error("GitHub author search returned another user's PR");
			if (isOwn && !ownNumbers.has(number)) continue;
			const feedback = (await this.feedback(pr.id, boundedSignal)).filter(
				(item) => item.author.toLowerCase() !== pr.author.toLowerCase()
			);
			const latest = new Map<string, PullRequestFeedback>();
			for (const item of feedback.filter(
				(item) => item.kind === "review" && item.state !== "COMMENTED"
			)) {
				const previous = latest.get(item.author.toLowerCase());
				if (!previous || previous.createdAt <= item.createdAt)
					latest.set(item.author.toLowerCase(), item);
			}
			const states = [...latest.values()].map((item) => item.state);
			const reviewState = !isOwn
				? "requested"
				: states.includes("CHANGES_REQUESTED")
					? "changes-requested"
					: states.includes("APPROVED")
						? "approved"
						: feedback.length
							? "commented"
							: "waiting";
			items.push(
				parsed(ReviewQueueItemSchema, {
					pr,
					repositoryId: repository.toLowerCase(),
					kind: isOwn ? "own" : "incoming",
					baseBranch: remote.base.ref,
					headBranch: remote.head.ref,
					updatedAt: remote.updated_at,
					draft: remote.draft,
					reviewState,
					feedbackCount: feedback.length,
					lastFeedbackAt: feedback.reduce<string | null>(
						(latest, item) => (!latest || item.updatedAt > latest ? item.updatedAt : latest),
						null
					),
				})
			);
		}
		return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async feedback(prId: string, signal?: AbortSignal): Promise<PullRequestFeedback[]> {
		const { repository, number } = parsePR(prId);
		const boundedSignal = operationSignal(signal);
		const root = repoPath(repository);
		const reviews = await this.pages(
			`${root}/pulls/${number}/reviews`,
			reviewSchema,
			boundedSignal
		);
		const inline = await this.pages(
			`${root}/pulls/${number}/comments`,
			inlineSchema,
			boundedSignal
		);
		const conversation = await this.pages(
			`${root}/issues/${number}/comments`,
			commentSchema,
			boundedSignal
		);
		const result: PullRequestFeedback[] = [];
		for (const row of reviews) {
			if (row.state === "PENDING") continue;
			if (!row.submitted_at)
				throw new Error("GitHub returned a submitted review without a timestamp");
			result.push(
				parsed(PullRequestFeedbackSchema, {
					id: `${prId}:review:${row.id}`,
					prId,
					author: row.user?.login ?? "",
					body: row.body,
					url: row.html_url,
					createdAt: row.submitted_at,
					updatedAt: row.submitted_at,
					kind: "review",
					state: row.state,
					path: null,
					line: null,
					commitSha: row.commit_id,
					suggestion: suggestion(row.body),
				})
			);
		}
		for (const row of inline)
			result.push(
				parsed(PullRequestFeedbackSchema, {
					id: `${prId}:inline:${row.id}`,
					prId,
					author: row.user?.login ?? "",
					body: row.body,
					url: row.html_url,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
					kind: "inline",
					state: null,
					path: row.path,
					// An outdated comment's original line belongs to original_commit_id, never the current head.
					// A LEFT diff line belongs to the base side, which this contract cannot identify.
					line: row.side === "LEFT" ? null : (row.line ?? row.original_line),
					commitSha: row.line === null ? row.original_commit_id : row.commit_id,
					suggestion:
						row.side === "RIGHT" &&
						((row.line === null ? row.original_start_line : row.start_line) == null ||
							(row.line === null ? row.original_start_line : row.start_line) ===
								(row.line ?? row.original_line))
							? suggestion(row.body)
							: null,
				})
			);
		for (const row of conversation)
			result.push(
				parsed(PullRequestFeedbackSchema, {
					id: `${prId}:conversation:${row.id}`,
					prId,
					author: row.user?.login ?? "",
					body: row.body,
					url: row.html_url,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
					kind: "conversation",
					state: null,
					path: null,
					line: null,
					commitSha: null,
					suggestion: suggestion(row.body),
				})
			);
		return [...new Map(result.map((item) => [item.id, item])).values()].sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt)
		);
	}

	async createDraft(
		input: { repository: string; base: string; head: string; title: string; body: string },
		signal?: AbortSignal
	): Promise<PullRequest> {
		const data = z
			.strictObject({
				repository: repositoryName,
				base: z.string().min(1).max(200),
				head: z.string().min(1).max(250),
				title: z.string().min(1).max(256),
				body: z.string().max(65536),
			})
			.parse(input);
		const { repository, ...fields } = data;
		const remote = parsed(
			pullSchema,
			(await this.request(`${repoPath(repository)}/pulls`, signal, { ...fields, draft: true })).data
		);
		if (!remote.draft)
			throw new Error("GitHub did not return a draft PR; check GitHub before retrying");
		pullRequest(repository, remote); // Verify the response belongs to the requested repository.
		return pullRequest(remote.base.repo.full_name, remote);
	}

	/** Exact commit-only Contents API. Missing is reported only after proving the commit exists. */
	async source(
		input: { repository: string; path: string; commitSha: string },
		signal?: AbortSignal
	): Promise<ReviewSource> {
		const { repository, path, commitSha } = z
			.strictObject({
				repository: repositoryName,
				path: RepositoryPathSchema.max(4096),
				commitSha: CommitShaSchema,
			})
			.parse(input);
		const boundedSignal = operationSignal(signal);
		const unavailable = (status: "missing" | "binary" | "too-large"): ReviewSource =>
			parsed(ReviewSourceSchema, { path, commitSha, status, content: null });
		let data: unknown;
		try {
			data = (
				await this.request(
					`${repoPath(repository)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commitSha}`,
					boundedSignal
				)
			).data;
		} catch (error) {
			if (!(error instanceof GitHubHttpError) || error.status !== 404) throw error;
			const commit = parsed(
				z.object({ sha: CommitShaSchema }),
				(await this.request(`${repoPath(repository)}/git/commits/${commitSha}`, boundedSignal)).data
			);
			if (commit.sha !== commitSha) throw new Error("GitHub returned a different source commit");
			return unavailable("missing");
		}
		const file = parsed(
			z.object({
				path: RepositoryPathSchema.max(4096),
				type: z.string().max(30),
				size: z.int().nonnegative(),
				encoding: z.string().max(30).optional(),
				content: z.string().optional(),
				submodule_git_url: z.string().nullable().optional(),
			}),
			data
		);
		if (file.path !== path || file.type !== "file" || file.submodule_git_url)
			throw new Error("GitHub source is not the requested regular file");
		if (file.size > 300000) return unavailable("too-large");
		if (file.encoding !== "base64" || file.content === undefined)
			throw new Error("GitHub did not provide complete source content");
		const encoded = file.content.replace(/\s/g, "");
		if (
			encoded.length > 400004 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
		)
			throw new Error("GitHub returned invalid source encoding");
		const bytes = Buffer.from(encoded, "base64");
		if (bytes.length !== file.size) throw new Error("GitHub returned incomplete source content");
		if (bytes.includes(0)) return unavailable("binary");
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			return unavailable("binary");
		}
		return parsed(ReviewSourceSchema, { path, commitSha, status: "available", content });
	}
}

function suggestion(body: string): string | null {
	const matches = [...body.matchAll(/^```suggestion([^\r\n]*)\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)];
	// A single line anchor cannot encode multiple/ranged replacements. Exact fences stay in body.
	return matches.length === 1 && matches[0]?.[1]?.trim() === ""
		? (matches[0]?.[2]?.replace(/\r?\n$/, "") ?? "")
		: null;
}
