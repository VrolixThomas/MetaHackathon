import { type PRFixDetail, PRFixDetailSchema } from "../../shared/contracts";
import { createPRFixController } from "./controller";

export const stamp = "2026-10-31T12:00:00.000Z";
export function fixDetail(id = "fix-1"): PRFixDetail {
	const pr = {
		id: "owner/repo#7",
		repository: "owner/repo",
		number: 7,
		url: "https://github.com/owner/repo/pull/7",
		title: "Handle empty input",
		author: "author",
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
	};
	const feedback = {
		id: "feedback-7",
		prId: pr.id,
		author: "reviewer",
		body: "Please handle empty input.\nOriginal words.",
		url: `${pr.url}#discussion_r7`,
		createdAt: stamp,
		updatedAt: stamp,
		kind: "inline",
		state: null,
		path: "src/main.ts",
		line: 2,
		commitSha: pr.headSha,
		suggestion: null,
	};
	const fix = {
		id,
		jobId: `candidate-${id}`,
		pr,
		feedback,
		phase: "ready",
		summary: "Return early for empty input.",
		question: null,
		baseSha: pr.headSha,
		headSha: "c".repeat(40),
		checks: [
			{
				id: "check-1",
				command: "bun",
				args: ["test", "empty.test.ts"],
				commitSha: "c".repeat(40),
				startedAt: stamp,
				finishedAt: stamp,
				exitCode: 0,
				logId: "log-1",
			},
		],
		changedFiles: ["src/main.ts", "empty.test.ts"],
		createdAt: stamp,
		updatedAt: stamp,
		reviewedAt: null,
		error: null,
		publication: "not-published",
	};
	return PRFixDetailSchema.parse({
		fix,
		review: {
			job: {
				id: fix.jobId,
				ticket: null,
				feedback,
				repositoryId: "repo-1",
				repository: pr.repository,
				state: "ready",
				branch: "muse/candidate",
				worktreePath: "/private/candidate",
				baseSha: fix.baseSha,
				headSha: fix.headSha,
				brief: "Prepare a local candidate",
				summary: fix.summary,
				createdAt: stamp,
				updatedAt: stamp,
				decisions: [],
				checks: fix.checks,
				changedFiles: fix.changedFiles,
				pullRequest: pr,
				error: null,
			},
			files: fix.changedFiles.map((path) => ({
				path,
				status: "modified",
				patch: "@@ -1,2 +1,3 @@\n const x = 1;\n-old();\n+if (!input) return;\n+newCall();",
				base: {
					path,
					commitSha: fix.baseSha,
					status: "available",
					content: "const x = 1;\r\nold();\r\n",
				},
				head: {
					path,
					commitSha: fix.headSha,
					status: "available",
					content: "const x = 1;\r\nif (!input) return;\r\nnewCall();\r\n",
				},
			})),
		},
	});
}
export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
export function harness(override?: (path: string, input: unknown) => unknown) {
	const calls: { type: string; path: string; input: unknown }[] = [];
	let detail = fixDetail();
	let actor: string | null = "actor-1";
	let request = 0;
	const controller = createPRFixController(
		async (type, path, input) => {
			calls.push({ type, path, input: structuredClone(input) });
			const custom = override?.(path, input);
			if (custom !== undefined) return custom;
			if (path === "prFixes.list") return [detail.fix];
			if (path === "prFixes.detail") return detail;
			if (path === "prFixes.start") {
				detail = fixDetail((input as { requestId: string }).requestId);
				return detail.fix;
			}
			if (path === "prFixes.reviewed") {
				detail = {
					...detail,
					fix: { ...detail.fix, reviewedAt: stamp, updatedAt: "2026-10-31T12:00:01.000Z" },
				};
				return detail.fix;
			}
			if (path === "prFixes.cancel") {
				detail = { fix: { ...detail.fix, phase: "interrupted" }, review: null };
				return undefined;
			}
			throw new Error(`Unexpected controlled RPC: ${path}`);
		},
		{ actor: () => actor, pollInterval: 0, requestId: () => `new-fix-${++request}` }
	);
	return {
		controller,
		calls,
		detail: () => detail,
		setDetail: (next: PRFixDetail) => {
			detail = next;
		},
		setActor: (next: string | null) => {
			actor = next;
		},
	};
}
/** React SSR reads the initial Zustand snapshot rather than live updates. */
export function ssrController(controller: ReturnType<typeof createPRFixController>) {
	return {
		...controller,
		store: { ...controller.store, getInitialState: controller.store.getState },
	};
}
