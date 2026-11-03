import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PullRequestSchema, RepositoryPathSchema, SourceFileSchema } from "../../shared/contracts";
import type { PinnedReviewFileRequest, PullRequest } from "../../shared/contracts";
import type { SubmissionLedger } from "../db/runtime-state";
import { type CredentialAccess, CredentialStore, type SecretEncryption } from "./credentials";
import { seedDemoRepositories } from "./demo";
import { executionEnvironment } from "./environment";
import { GitHubClient, GitHubPRIdSchema } from "./github";
import {
	describeLocalRepository,
	readLocalReviewSource,
	validateLocalRepository,
} from "./local-review";
import { type PreviewPageFactory, PreviewRunner } from "./preview";
import { runProcess } from "./process";
import { type PreparedRepository, RepositoryManager } from "./repositories";
import { ScenarioRunner } from "./scenarios";

export interface RuntimeOptions {
	userDataPath: string;
	fixturesPath: string;
	encryption: SecretEncryption;
	credentialStore?: CredentialAccess;
	createPreviewPage: PreviewPageFactory;
	submissionLedger: SubmissionLedger;
	nodeExecutable?: string;
}

/** Main owns this instance. Router methods return JSON contracts, never credentials or processes. */
export class RuntimeService {
	readonly credentials: CredentialAccess;
	readonly github: GitHubClient;
	readonly repositories: RepositoryManager;
	readonly scenarios: ScenarioRunner;
	readonly previews: PreviewRunner;
	private seed?: Awaited<ReturnType<typeof seedDemoRepositories>>;
	private demoPromise?: Promise<PullRequest[]>;
	private readonly prepared = new Map<string, { pr: PullRequest; worktrees: PreparedRepository }>();
	private readonly previewSources = new Map<
		string,
		{ pr: PullRequest; worktrees: PreparedRepository }
	>();
	private readonly preparingPreviewSources = new Map<
		string,
		Promise<{ pr: PullRequest; worktrees: PreparedRepository }>
	>();
	private readonly preparing = new Map<
		string,
		{
			baseSha: string;
			headSha: string;
			done: Promise<{ pr: PullRequest; worktrees: PreparedRepository }>;
		}
	>();
	private readonly operations = new Map<
		string,
		{ controller: AbortController; done: Promise<unknown> }
	>();
	private readonly previewStops = new Map<string, () => Promise<void>>();
	private closed = false;
	private disposal?: Promise<void>;

	constructor(private readonly options: RuntimeOptions) {
		this.credentials =
			options.credentialStore ??
			new CredentialStore(join(options.userDataPath, "credentials"), options.encryption);
		this.github = new GitHubClient(this.credentials, fetch, options.submissionLedger);
		this.repositories = new RepositoryManager(join(options.userDataPath, "runtime", "worktrees"));
		this.scenarios = new ScenarioRunner(
			join(options.userDataPath, "runtime", "logs"),
			options.nodeExecutable
		);
		this.previews = new PreviewRunner(
			join(options.userDataPath, "runtime", "logs"),
			options.createPreviewPage,
			options.nodeExecutable
		);
	}

	prepareDemo(): Promise<PullRequest[]> {
		if (this.closed) return Promise.reject(new Error("Runtime has shut down"));
		this.demoPromise ??= this.createDemo().catch((error) => {
			this.demoPromise = undefined;
			throw error;
		});
		return this.demoPromise;
	}

	private async createDemo() {
		this.seed ??= await seedDemoRepositories(
			join(this.options.userDataPath, "runtime", "demo"),
			this.options.fixturesPath
		);
		const prs: PullRequest[] = [];
		for (const [repository, number, title, source] of [
			["demo/shop-web", 1284, "Stackable promo codes at checkout", this.seed.shop],
			["demo/finance-service", 412, "Read promo_code in the finance export", this.seed.finance],
		] as const) {
			const pr = PullRequestSchema.parse({
				id: `${repository}#${number}`,
				repository,
				number,
				title,
				author: "Noor",
				url: `https://example.invalid/${repository}/pull/${number}`,
				baseSha: source.baseSha,
				headSha: source.headSha,
			});
			if (!this.prepared.has(pr.id)) {
				const worktrees = await this.repositories.prepare({
					repositoryPath: source.path,
					baseRef: source.baseSha,
					headRef: source.headSha,
				});
				this.prepared.set(pr.id, { pr, worktrees });
			}
			prs.push(pr);
		}
		return prs;
	}

	/** Main-only preparation port for the agent/background worker; no raw commands in renderer RPCs. */
	async prepareGitHub(prInput: PullRequest, repositoryPath?: string, signal?: AbortSignal) {
		const pr = PullRequestSchema.parse(prInput);
		if (this.closed) throw new Error("Runtime has shut down");
		const existing = this.prepared.get(pr.id);
		if (existing) {
			if (existing.pr.baseSha !== pr.baseSha || existing.pr.headSha !== pr.headSha)
				throw new Error("Release the old PR revision before preparing a new head");
			return existing;
		}
		const pending = this.preparing.get(pr.id);
		if (pending) {
			if (pending.baseSha !== pr.baseSha || pending.headSha !== pr.headSha)
				throw new Error("Another PR revision is being prepared");
			return pending.done;
		}
		const done = this.operation(`prepare:${pr.id}`, async (localSignal) => {
			const worktrees = await this.repositories.prepare({
				...(repositoryPath
					? { repositoryPath }
					: { cloneUrl: `https://github.com/${pr.repository}.git` }),
				prNumber: pr.number,
				baseRef: pr.baseSha,
				signal: signal ? AbortSignal.any([signal, localSignal]) : localSignal,
			});
			if (worktrees.base.sha !== pr.baseSha || worktrees.head.sha !== pr.headSha) {
				await this.repositories.cleanup(worktrees.runId);
				throw new Error("GitHub head changed during preparation; reload the PR");
			}
			const prepared = { pr, worktrees };
			this.prepared.set(pr.id, prepared);
			return prepared;
		}).finally(() => {
			this.preparing.delete(pr.id);
		});
		this.preparing.set(pr.id, { baseSha: pr.baseSha, headSha: pr.headSha, done });
		return done;
	}

	/** Preview sources are isolated per exact revision, so a later author fix never replaces an older reader's source. */
	async preparePreviewGitHub(prInput: PullRequest, signal?: AbortSignal) {
		const pr = PullRequestSchema.parse(prInput);
		if (this.closed) throw new Error("Runtime has shut down");
		const key = JSON.stringify([pr.id, pr.baseSha, pr.headSha]);
		const existing = this.previewSources.get(key);
		if (existing) return existing;
		const pending = this.preparingPreviewSources.get(key);
		if (pending) return pending;
		const done = this.operation(`preview-source:${randomUUID()}`, async (localSignal) => {
			const active = signal ? AbortSignal.any([signal, localSignal]) : localSignal;
			const worktrees = await this.repositories.prepare({
				cloneUrl: `https://github.com/${pr.repository}.git`,
				prNumber: pr.number,
				baseRef: pr.baseSha,
				signal: active,
			});
			if (
				active.aborted ||
				worktrees.base.sha !== pr.baseSha ||
				worktrees.head.sha !== pr.headSha
			) {
				await this.repositories.cleanup(worktrees.runId);
				throw new Error("PR revision changed while preparing its preview");
			}
			const prepared = { pr, worktrees };
			this.previewSources.set(key, prepared);
			return prepared;
		}).finally(() => this.preparingPreviewSources.delete(key));
		this.preparingPreviewSources.set(key, done);
		return done;
	}

	getPrepared(prId: string) {
		const prepared = this.prepared.get(prId);
		if (!prepared) throw new Error("PR is not prepared");
		return prepared;
	}

	/** V1 context is a bounded GitHub read and never seeds or clones a repository. */
	prContext(prId: string, signal?: AbortSignal) {
		return this.operation(`pr-context:${randomUUID()}`, (localSignal) =>
			this.github.prContext(prId, signal ? AbortSignal.any([signal, localSignal]) : localSignal)
		);
	}

	repositoryPullRequests(repository: string, signal?: AbortSignal) {
		return this.operation(`repository-prs:${randomUUID()}`, (localSignal) =>
			this.github.openPullRequests(
				repository,
				signal ? AbortSignal.any([signal, localSignal]) : localSignal
			)
		);
	}

	reviewFile(input: PinnedReviewFileRequest, signal?: AbortSignal, localPath?: string) {
		return this.operation(`review-file:${randomUUID()}`, async (localSignal) => {
			const combined = signal ? AbortSignal.any([signal, localSignal]) : localSignal;
			const repository = GitHubPRIdSchema.parse(input.prId).split("#")[0] as string;
			const root = localPath
				? await validateLocalRepository(localPath, repository, combined)
				: undefined;
			return this.github.reviewFile(
				input,
				combined,
				root
					? (_repository, path, sha, signal) =>
							readLocalReviewSource(root, repository, path, sha, signal)
					: undefined
			);
		});
	}

	describeRepository(path: string, signal?: AbortSignal) {
		return this.operation(`describe-repository:${randomUUID()}`, (localSignal) =>
			describeLocalRepository(path, signal ? AbortSignal.any([signal, localSignal]) : localSignal)
		);
	}
	validateLocalRepository(path: string, repository: string, signal?: AbortSignal) {
		return this.operation(`validate-repository:${randomUUID()}`, (localSignal) =>
			validateLocalRepository(
				path,
				repository,
				signal ? AbortSignal.any([signal, localSignal]) : localSignal
			)
		);
	}

	async changedFiles(prId: string) {
		const { pr, worktrees } = this.getPrepared(prId);
		const result = await runProcess({
			command: "git",
			args: ["diff", "--name-only", "-z", pr.baseSha, pr.headSha, "--"],
			cwd: worktrees.repositoryPath,
			env: executionEnvironment(),
			timeoutMs: 10_000,
		});
		if (result.exitCode !== 0 || result.outputTruncated)
			throw new Error("Could not read complete changed files");
		return result.stdout
			.split("\0")
			.filter(Boolean)
			.map((path) => RepositoryPathSchema.parse(path));
	}

	async source(prId: string, revision: "base" | "head", pathInput: string) {
		const path = RepositoryPathSchema.parse(pathInput);
		const { pr, worktrees } = this.getPrepared(prId);
		const commitSha = revision === "base" ? pr.baseSha : pr.headSha;
		const entry = await runProcess({
			command: "git",
			args: ["--literal-pathspecs", "ls-tree", "--full-tree", "-z", commitSha, "--", path],
			cwd: worktrees.repositoryPath,
			env: executionEnvironment(),
			timeoutMs: 10_000,
			maxOutputBytes: 16_384,
		});
		if (entry.exitCode !== 0 || entry.outputTruncated)
			throw new Error("Could not inspect the committed source file");
		if (!entry.stdout)
			return SourceFileSchema.parse({
				prId,
				repository: pr.repository,
				revision,
				commitSha,
				path,
				content: null,
			});
		if (!/^\d+ blob /.test(entry.stdout)) throw new Error("Requested source is not a file");
		const result = await runProcess({
			command: "git",
			args: ["show", "--no-ext-diff", "--no-textconv", `${commitSha}:${path}`],
			cwd: worktrees.repositoryPath,
			env: executionEnvironment(),
			timeoutMs: 10_000,
			maxOutputBytes: 1_000_000,
		});
		if (result.exitCode !== 0 || result.timedOut || result.aborted || result.outputTruncated)
			throw new Error("Source read did not complete");
		return SourceFileSchema.parse({
			prId,
			repository: pr.repository,
			revision,
			commitSha,
			path,
			content: result.stdout,
		});
	}

	async diff(prId: string, pathInput: string) {
		const path = RepositoryPathSchema.parse(pathInput);
		const { pr, worktrees } = this.getPrepared(prId);
		const result = await runProcess({
			command: "git",
			args: [
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--unified=3",
				pr.baseSha,
				pr.headSha,
				"--",
				path,
			],
			cwd: worktrees.repositoryPath,
			env: executionEnvironment(),
			timeoutMs: 10_000,
			maxOutputBytes: 1_000_000,
		});
		if (result.exitCode !== 0 || result.outputTruncated)
			throw new Error("Complete diff read failed");
		return { prId, path, baseSha: pr.baseSha, headSha: pr.headSha, patch: result.stdout };
	}

	runScenario(requestId: string, prId: string, scenarioId: string) {
		return this.operation(requestId, async (signal) => {
			const { pr, worktrees } = this.getPrepared(prId);
			return this.scenarios.runScenario({
				pr,
				worktrees,
				scenarioId,
				title: `Scenario ${scenarioId}`,
				timeoutMs: 30_000,
				signal,
			});
		});
	}

	startPreview(
		requestId: string,
		prId: string,
		mode: "phone" | "desktop",
		revision: "base" | "head" = "head"
	) {
		return this.operation(requestId, async (signal) => {
			const { pr, worktrees } = this.getPrepared(prId);
			const result = await this.previews.start({
				pr,
				path: worktrees[revision].path,
				sha: worktrees[revision].sha,
				mode,
				revision,
				signal,
			});
			if (signal.aborted) {
				await result.stop();
				throw new Error("Preview cancelled before registration");
			}
			this.previewStops.set(result.preview.id, result.stop);
			return result.preview;
		});
	}

	async stopPreview(id: string) {
		const stop = this.previewStops.get(id);
		if (stop) {
			await stop();
			this.previewStops.delete(id);
		}
	}

	cancel(requestId: string) {
		const operation = this.operations.get(requestId);
		operation?.controller.abort();
		return { cancelled: Boolean(operation) };
	}

	private operation<T>(requestId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Error("Runtime has shut down"));
		if (this.operations.has(requestId))
			return Promise.reject(new Error("Runtime request is already running"));
		const controller = new AbortController();
		const done = Promise.resolve()
			.then(() => work(controller.signal))
			.finally(() => {
				this.operations.delete(requestId);
			});
		this.operations.set(requestId, { controller, done });
		return done;
	}

	dispose(): Promise<void> {
		this.disposal ??= this.disposeOwned();
		return this.disposal;
	}

	private async disposeOwned() {
		this.closed = true;
		for (const operation of this.operations.values()) operation.controller.abort();
		await Promise.allSettled([...this.operations.values()].map((operation) => operation.done));
		await this.scenarios.dispose();
		await this.demoPromise?.catch(() => undefined);
		await this.previews.dispose();
		const failures: unknown[] = [];
		for (const [id, prepared] of this.previewSources) {
			try {
				await this.repositories.cleanup(prepared.worktrees.runId);
				this.previewSources.delete(id);
			} catch (error) {
				failures.push(error);
			}
		}
		for (const [id, prepared] of this.prepared) {
			try {
				await this.repositories.cleanup(prepared.worktrees.runId);
				this.prepared.delete(id);
			} catch (error) {
				failures.push(error);
			}
		}
		if (this.seed && failures.length === 0) await this.seed.cleanup();
		if (failures.length)
			throw new AggregateError(
				failures,
				"Runtime preserved worktrees that could not be safely cleaned"
			);
	}
}
