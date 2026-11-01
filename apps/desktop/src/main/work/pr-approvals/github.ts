import { createHash } from "node:crypto";
import { z } from "zod";
import {
	type ApprovalPolicy,
	ApprovalPolicySchema,
	CommitShaSchema,
	type PullRequest,
	RepositoryPathSchema,
} from "../../../shared/contracts";

const actorSchema = ApprovalPolicySchema.shape.actor;
const fileSchema = z.object({
	filename: RepositoryPathSchema,
	status: z.string(),
	previous_filename: z.string().optional(),
});
const pullSchema = z.object({
	number: z.int().positive(),
	title: z.string().max(1024),
	body: z.string().max(1000000).nullable(),
	state: z.string(),
	draft: z.boolean(),
	user: actorSchema,
	base: z.object({
		sha: CommitShaSchema,
		ref: z.string(),
		repo: z.object({ full_name: z.string() }),
	}),
	head: z.object({ sha: CommitShaSchema }),
});
const contextDigest = (pr: z.infer<typeof pullSchema>) =>
	createHash("sha256")
		.update(
			JSON.stringify([
				pr.title,
				pr.body,
				pr.base.ref,
				pr.base.repo.full_name.toLowerCase(),
				pr.user.id,
			])
		)
		.digest("hex");
export type ApprovalObservation = {
	scopeError?: string;
	contextDigest: string;
	actor: ApprovalPolicy["actor"];
	headSha: string;
	baseSha: string;
	open: boolean;
	permitted: boolean;
	descendant: boolean;
	changes: { path: string; status: string }[];
	checks: {
		id?: number;
		name: string;
		appId: number | null;
		passed: boolean;
		url: string | null;
	}[];
	required: { name: string; appId: number | null }[];
	sources: { path: string; content: string }[];
};
export class ApprovalExpiredBeforePost extends Error {
	constructor() {
		super("The approval delegation expired before dispatch");
	}
}
export interface ApprovalProvider {
	pin(pr: PullRequest, signal: AbortSignal): Promise<string>;
	account(signal: AbortSignal): Promise<ApprovalPolicy["actor"]>;
	observe(policy: ApprovalPolicy, signal: AbortSignal): Promise<ApprovalObservation>;
	approve(
		policy: ApprovalPolicy,
		headSha: string,
		attemptId: string,
		signal: AbortSignal,
		beforePost?: () => void
	): Promise<{ id: number; url: string }>;
}
/** Captures one credential per bounded operation. Never switches identity halfway through a write. */
export class ApprovalGitHub implements ApprovalProvider {
	constructor(
		private readonly token: () => Promise<string | undefined>,
		private readonly epoch: () => number,
		private readonly transport: typeof fetch = fetch,
		private readonly now: () => number = Date.now
	) {}
	private async session(signal: AbortSignal, beforePost?: () => void) {
		const epoch = this.epoch();
		const token = await this.token();
		if (epoch !== this.epoch()) throw new Error("GitHub account changed");
		if (!token) throw new Error("GitHub connection required");
		const request = async (path: string, body?: unknown): Promise<unknown> => {
			signal.throwIfAborted();
			if ((await this.token()) !== token || this.epoch() !== epoch)
				throw new Error("GitHub account changed");
			signal.throwIfAborted();
			// Last synchronous boundary: no credential or provider await may follow this guard.
			if (body) beforePost?.();
			const response = await this.transport(`https://api.github.com${path}`, {
				method: body ? "POST" : "GET",
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"Content-Type": "application/json",
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			});
			if (!response.ok) throw new Error("GitHub approval source unavailable");
			if (!response.body) throw new Error("Missing GitHub response");
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > 4_000_000) throw new Error("GitHub approval read limit");
					chunks.push(value);
					signal.throwIfAborted();
				}
			} finally {
				void reader.cancel().catch(() => {});
				reader.releaseLock();
			}
			signal.throwIfAborted();
			if (this.epoch() !== epoch) throw new Error("GitHub account changed");
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		};
		const actor = actorSchema.parse(await request("/user"));
		return { request, actor };
	}
	async account(signal: AbortSignal) {
		return (await this.session(signal)).actor;
	}
	async pin(pr: PullRequest, signal: AbortSignal) {
		const { request } = await this.session(signal);
		const current = pullSchema.parse(
			await request(
				`/repos/${pr.repository.split("/").map(encodeURIComponent).join("/")}/pulls/${pr.number}`
			)
		);
		if (
			current.number !== pr.number ||
			current.base.repo.full_name.toLowerCase() !== pr.repository.toLowerCase() ||
			current.head.sha !== pr.headSha ||
			current.base.sha !== pr.baseSha ||
			current.title !== pr.title ||
			current.user.login !== pr.author ||
			current.state !== "open" ||
			current.draft
		)
			throw new Error("Review the current PR scope first");
		return contextDigest(current);
	}
	async observe(policy: ApprovalPolicy, signal: AbortSignal): Promise<ApprovalObservation> {
		const { request, actor } = await this.session(signal);
		const root = `/repos/${policy.pr.repository.split("/").map(encodeURIComponent).join("/")}`;
		const path = `${root}/pulls/${policy.pr.number}`;
		const pr = pullSchema.parse(await request(path));
		if (
			pr.number !== policy.pr.number ||
			pr.base.repo.full_name.toLowerCase() !== policy.pr.repository.toLowerCase()
		)
			throw new Error("PR identity mismatch");
		const repository = z
			.object({ permissions: z.object({ push: z.boolean() }) })
			.parse(await request(root));
		// Active branch rules include rulesets as well as classic protection. Unknown rules fail closed.
		const rules = z
			.array(z.object({ type: z.string(), parameters: z.unknown().optional() }))
			.max(100)
			.parse(await request(`${root}/rules/branches/${encodeURIComponent(pr.base.ref)}`));
		const required: ApprovalObservation["required"] = [];
		for (const rule of rules)
			if (rule.type === "required_status_checks") {
				const p = z
					.object({
						required_status_checks: z
							.array(
								z.object({
									context: z.string().min(1).max(200),
									integration_id: z.int().nullable().optional(),
								})
							)
							.max(100),
					})
					.parse(rule.parameters);
				required.push(
					...p.required_status_checks.map((c) => ({
						name: c.context,
						appId: c.integration_id && c.integration_id > 0 ? c.integration_id : null,
					}))
				);
			}
		const branch = z
			.object({
				protected: z.boolean(),
				protection: z
					.object({
						required_status_checks: z
							.object({
								contexts: z.array(z.string()).max(100),
								checks: z
									.array(z.object({ context: z.string(), app_id: z.int().nullable() }))
									.max(100)
									.optional(),
							})
							.nullable()
							.optional(),
					})
					.optional(),
			})
			.parse(await request(`${root}/branches/${encodeURIComponent(pr.base.ref)}`));
		if (branch.protected && !branch.protection)
			throw new Error("Branch protection could not be verified");
		const classic = branch.protection?.required_status_checks;
		if (classic) {
			required.push(
				...[
					...(classic.checks ?? []),
					...classic.contexts
						.filter((context) => !classic.checks?.some((c) => c.context === context))
						.map((context) => ({ context, app_id: null })),
				].map((c) => ({ name: c.context, appId: c.app_id && c.app_id > 0 ? c.app_id : null }))
			);
		}
		let descendant = pr.head.sha === policy.pr.headSha;
		const changes: ApprovalObservation["changes"] = [];
		if (!descendant) {
			const compare = z
				.object({
					status: z.string(),
					merge_base_commit: z.object({ sha: CommitShaSchema }),
					files: z.array(fileSchema).max(299),
				})
				.parse(await request(`${root}/compare/${policy.pr.headSha}...${pr.head.sha}?per_page=1`));
			descendant =
				compare.status === "ahead" && compare.merge_base_commit.sha === policy.pr.headSha;
			changes.push(
				...compare.files.map((f) => ({
					path: f.filename,
					status: f.previous_filename ? "renamed" : f.status,
				}))
			);
			// 300 is the provider truncation boundary; never infer complete scope there.
			if (!changes.length) descendant = false;
		}
		const checks: ApprovalObservation["checks"] = [];
		const runSchema = z.object({
			id: z.int().positive(),
			name: z.string(),
			head_sha: CommitShaSchema,
			status: z.string(),
			conclusion: z.string().nullable(),
			html_url: z.url().nullable(),
			app: z.object({ id: z.int().positive() }),
		});
		for (let page = 1; page <= 5; page++) {
			const runs = z
				.object({
					total_count: z.int().nonnegative().max(499),
					check_runs: z.array(runSchema).max(100),
				})
				.parse(
					await request(
						`${root}/commits/${pr.head.sha}/check-runs?filter=latest&per_page=100&page=${page}`
					)
				);
			for (const r of runs.check_runs) {
				if (r.head_sha !== pr.head.sha) throw new Error("Check head mismatch");
				checks.push({
					id: r.id,
					name: r.name,
					appId: r.app.id,
					passed: r.status === "completed" && r.conclusion === "success",
					url: r.html_url,
				});
			}
			if (page * 100 >= runs.total_count) break;
			if (page === 5) throw new Error("Check read limit");
		}
		// Statuses are newest first. Preserve only the latest occurrence of each context.
		const statusNames = new Set<string>();
		for (let page = 1; page <= 5; page++) {
			const statuses = z
				.array(
					z.object({
						id: z.int().positive(),
						context: z.string(),
						state: z.string(),
						target_url: z.url().nullable(),
					})
				)
				.max(100)
				.parse(await request(`${root}/commits/${pr.head.sha}/statuses?per_page=100&page=${page}`));
			for (const s of statuses)
				if (!statusNames.has(s.context)) {
					statusNames.add(s.context);
					checks.push({
						id: s.id,
						name: s.context,
						appId: null,
						passed: s.state === "success",
						url: s.target_url,
					});
				}
			if (statuses.length < 100) break;
			if (page === 5) throw new Error("Status read limit");
		}
		const sources: ApprovalObservation["sources"] = [];
		let scopeError: string | undefined;
		const mayReadSources =
			descendant &&
			contextDigest(pr) === policy.contextDigest &&
			pr.base.sha === policy.pr.baseSha &&
			changes.every(
				(f) =>
					["modified", "added"].includes(f.status) &&
					policy.terms.conditions.some((c) => c.kind === "source" && c.path === f.path)
			);
		const trees = new Map<string, { path: string; mode: string; sha: string; type: string }[]>();
		const treePath = async (sha: string, path: string) => {
			let treeSha = sha;
			const parts = path.split("/");
			for (let i = 0; i < parts.length; i++) {
				let entries = trees.get(treeSha);
				if (!entries) {
					const tree = z
						.object({
							truncated: z.literal(false),
							tree: z
								.array(
									z.object({
										path: z.string(),
										mode: z.string(),
										sha: CommitShaSchema,
										type: z.string(),
									})
								)
								.max(20000),
						})
						.parse(await request(`${root}/git/trees/${treeSha}`));
					entries = tree.tree;
					trees.set(treeSha, entries);
				}
				const entry = entries.find((e) => e.path === parts[i]);
				if (!entry) return null;
				if (i === parts.length - 1) return entry;
				if (entry.type !== "tree" || entry.mode !== "040000")
					throw new Error("Source parent is not a regular directory");
				treeSha = entry.sha;
			}
			return null;
		};
		for (const c of policy.terms.conditions)
			if (mayReadSources && c.kind === "source") {
				const file = z
					.object({
						type: z.literal("file"),
						path: z.string(),
						size: z.int().max(120000),
						encoding: z.literal("base64"),
						content: z.string().max(170000),
					})
					.parse(
						await request(
							`${root}/contents/${c.path.split("/").map(encodeURIComponent).join("/")}?ref=${pr.head.sha}`
						)
					);
				const bytes = Buffer.from(file.content.replace(/\s/g, ""), "base64");
				const tree = await treePath(pr.head.sha, c.path);
				const previous =
					pr.head.sha === policy.pr.headSha ? tree : await treePath(policy.pr.headSha, c.path);
				const blob = createHash("sha1")
					.update(`blob ${bytes.length}\0`)
					.update(bytes)
					.digest("hex");
				if (
					!tree ||
					tree.type !== "blob" ||
					!["100644", "100755"].includes(tree.mode) ||
					tree.sha !== blob ||
					(previous
						? previous.type !== "blob" || previous.mode !== tree.mode
						: tree.mode !== "100644")
				) {
					scopeError =
						"A file type or executable mode changed outside the exact source authorization. Review the new scope.";
					break;
				}
				if (file.path !== c.path || file.size !== bytes.length || bytes.includes(0))
					throw new Error("Incomplete source");
				sources.push({
					path: c.path,
					content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
				});
			}
		const end = pullSchema.parse(await request(path));
		if (
			end.head.sha !== pr.head.sha ||
			end.base.sha !== pr.base.sha ||
			contextDigest(end) !== contextDigest(pr)
		)
			throw new Error("PR changed while evaluating");
		return {
			actor,
			contextDigest: contextDigest(pr),
			...(scopeError ? { scopeError } : {}),
			headSha: pr.head.sha,
			baseSha: pr.base.sha,
			open: end.state === "open" && !end.draft,
			permitted: repository.permissions.push && actor.id !== pr.user.id,
			descendant,
			changes,
			checks,
			required,
			sources,
		};
	}
	async approve(
		policy: ApprovalPolicy,
		headSha: string,
		attemptId: string,
		signal: AbortSignal,
		beforePost?: () => void
	) {
		const { request, actor } = await this.session(signal, () => {
			beforePost?.();
			if (Date.parse(policy.terms.expiresAt) <= this.now()) throw new ApprovalExpiredBeforePost();
		});
		if (actor.id !== policy.actor.id) throw new Error("GitHub account changed");
		const root = `/repos/${policy.pr.repository.split("/").map(encodeURIComponent).join("/")}/pulls/${policy.pr.number}`;
		const pr = pullSchema.parse(await request(root));
		if (
			contextDigest(pr) !== policy.contextDigest ||
			pr.head.sha !== headSha ||
			pr.base.sha !== policy.pr.baseSha ||
			pr.state !== "open" ||
			pr.draft
		)
			throw new Error("PR changed before approval");
		const review = z
			.object({
				id: z.int().positive(),
				html_url: z.url(),
				commit_id: CommitShaSchema,
				state: z.literal("APPROVED"),
				user: actorSchema,
			})
			.parse(
				await request(`${root}/reviews`, {
					event: "APPROVE",
					commit_id: headSha,
					body: `Approved under MuseFocus delegation ${policy.id}, revision ${policy.revision}.\nAttempt: ${attemptId}`,
				})
			);
		const receiptUrl = new URL(review.html_url);
		if (
			review.commit_id !== headSha ||
			review.user.id !== actor.id ||
			receiptUrl.origin !== "https://github.com" ||
			receiptUrl.pathname.toLowerCase() !==
				`/${policy.pr.repository}/pull/${policy.pr.number}`.toLowerCase() ||
			receiptUrl.hash !== `#pullrequestreview-${review.id}`
		)
			throw new Error("Approval receipt mismatch");
		return { id: review.id, url: review.html_url };
	}
}
