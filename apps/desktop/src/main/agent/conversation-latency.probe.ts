/** Controlled production-orchestration probe. No native app, provider, credentials or audio. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	ConversationTurnInput,
	HubSnapshot,
	LinearTicket,
	PreparedReview,
	WorkJob,
	WorkspaceObservation,
} from "../../shared/contracts";
import type { ConversationService as Service } from "./conversation";
import type { ConversationHubPorts } from "./hub-tools";
import type { AgentModelClient, MetaItem, MetaRequest } from "./meta-client";
import type { ConversationWorkspacePorts } from "./workspace-tools";

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const unexpected = () => {
	throw new Error("Unexpected controlled probe operation");
};
const unusedPorts = new Proxy({}, { get: () => unexpected });
const text = (value: string): MetaItem[] => [
	{ type: "message", role: "assistant", content: [{ type: "output_text", text: value }] },
];
const tool = (): MetaItem[] => [
	{
		type: "function_call",
		name: "open_command_center",
		call_id: "show-tickets",
		status: "completed",
		arguments: JSON.stringify({ section: "tickets" }),
	},
];

export async function probeConversationLatency(ServiceClass: typeof Service, portDelayMs = 10) {
	const scenarios = [
		{ name: "simple", turns: ["Hello"], outputs: [text("Hello. What would you like to discuss?")] },
		{
			name: "planning-followup",
			turns: ["Let's discuss persistence before starting any work", "Continue?"],
			outputs: [
				text("Should persistence last in this tab or across restarts?"),
				text("We were choosing how long persistence should last."),
			],
		},
		{
			name: "workspace-action",
			turns: ["Open my tickets"],
			outputs: [tool(), text("Your tickets are open.")],
		},
	];
	scenarios.push(
		{
			name: "selected-ticket",
			turns: ["Explain this ticket"],
			outputs: [text("This ticket needs an explicit persistence choice.")],
		},
		{
			name: "scoped-dispatch",
			turns: ["Start MET-77 with persistence across browser restarts on this device."],
			outputs: [
				[
					{
						type: "function_call",
						name: "start_work",
						call_id: "start",
						status: "completed",
						arguments: JSON.stringify({
							ticketId: "ticket",
							repositoryId: "repo",
							brief: "Persist across browser restarts on this device.",
						}),
					},
				],
				text("The requested work has started."),
			],
		},
		{
			name: "selected-pr",
			turns: ["Explain this file"],
			outputs: [text("This file adjusts the timeout from one to two.")],
		}
	);
	const measurements = [];
	for (const scenario of scenarios) {
		let workspaceReads = 0;
		let hubReads = 0;
		let dayReads = 0;
		let receiptWaitMs = 0;
		let ticketReads = 0;
		let sourceReads = 0;
		let admissions = 0;
		let start = 0;
		let firstPublishedMs: number | null = null;
		const requests: Array<{
			inputBytes: number;
			instructionBytes: number;
			toolBytes: number;
			toolCount: number;
			workload: string;
			requestedAtMs: number;
			firstProviderTextMs: number;
			terminalMs: number;
		}> = [];
		const hub: HubSnapshot = {
			sequence: 1,
			refreshedAt: "2026-11-02T00:00:00Z",
			refreshing: false,
			viewer: { githubLogin: "controlled", linearName: "Controlled" },
			connections: { github: true, linear: true, model: true },
			repositories: [],
			reviews: [],
			tickets: [],
			jobs: [],
			notices: [],
			preferences: {
				linearTeamIds: [],
				linearProjectIds: [],
				maxWorkers: 2,
				autoApplySuggestions: false,
			},
			errors: [],
		};
		const ticket: LinearTicket = {
			id: "ticket",
			identifier: "MET-77",
			title: "Persistence",
			description:
				"Decide whether state lasts only in a tab or across browser restarts on this device. No account sync.",
			url: "https://linear.app/test/issue/MET-77",
			updatedAt: "2026-11-02T00:00:00Z",
			state: { id: "open", name: "Open", type: "unstarted" },
			priority: 1,
			teamId: "team",
			teamName: "Controlled",
			projectId: null,
			projectName: null,
			assigneeId: "controlled",
			assigneeName: "Controlled",
		};
		const pr = {
			id: "pr",
			repository: "controlled/repo",
			number: 1,
			title: "Timeout",
			author: "controlled",
			url: "https://github.com/controlled/repo/pull/1",
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
		};
		const prepared: PreparedReview = {
			id: "review",
			version: 1,
			pr,
			createdAt: "2026-11-02T00:00:00Z",
			summary: "Inferred timeout change",
			orderRationale: "Behavior first",
			coverage: "complete",
			evidence: "inferred-from-github",
			files: [
				{
					path: "service.ts",
					reason: "Inferred behavior",
					summary: "Timeout changes",
					suggestedComments: [],
				},
			],
		};
		if (["selected-ticket", "scoped-dispatch"].includes(scenario.name)) {
			const { description: _description, ...summary } = ticket;
			hub.tickets = [summary];
			hub.repositories = [
				{
					id: "repo",
					repository: "controlled/repo",
					localPath: null,
					defaultBranch: "main",
					addedAt: "2026-11-02T00:00:00Z",
					linearTeamIds: [],
					linearProjectIds: [],
				},
			];
		}
		const readHub = async () => {
			hubReads++;
			await delay(portDelayMs);
			return structuredClone(hub);
		};
		let observation: WorkspaceObservation = {
			workspace: {
				sequence: 0,
				canvases: [{ id: "home", kind: "center", title: "Home", section: "home", revision: 1 }],
				primaryId: "home",
				secondaryId: null,
				review: { sequence: 0, mode: "conversation", prId: null },
				codeView: "diff",
				browser: null,
			},
			browser: null,
			reviews: [],
			capabilities: [
				"documents",
				"visuals",
				"browser",
				"review",
				"center",
				"source",
				"flow",
				"images",
			],
			hub,
		};
		if (["selected-ticket", "scoped-dispatch"].includes(scenario.name))
			observation.workspace.canvases = [
				{
					id: "home",
					kind: "center",
					title: "Ticket",
					section: "tickets",
					selectedId: "ticket",
					revision: 1,
				},
			];
		if (scenario.name === "selected-pr") {
			observation.workspace.canvases = [
				{ id: "home", kind: "review", title: "Review", revision: 1 },
			];
			observation.workspace.review = {
				sequence: 1,
				mode: "review",
				prId: pr.id,
				reviewId: prepared.id,
				baseSha: pr.baseSha,
				headSha: pr.headSha,
				path: "service.ts",
				paused: false,
			};
			observation.reviews = [{ pr, status: "ready", reviewId: prepared.id }];
		}
		const hubPorts = {
			...Object.fromEntries(
				["operate", "ticket", "job", "jobLog", "feedback", "reviewWork", "source", "search"].map(
					(key) => [key, unexpected]
				)
			),
			snapshot: readHub,
			ticket: async () => {
				ticketReads++;
				await delay(portDelayMs);
				return structuredClone(ticket);
			},
			operate: async (operation: { kind: string }) => {
				assert.equal(operation.kind, "start-work");
				admissions++;
				const job: WorkJob = {
					id: "job",
					ticket,
					repositoryId: "repo",
					repository: "controlled/repo",
					state: "queued",
					branch: "controlled",
					worktreePath: null,
					baseSha: null,
					headSha: null,
					brief: "Persist across restarts",
					summary: "Queued",
					createdAt: "2026-11-02T00:00:00Z",
					updatedAt: "2026-11-02T00:00:00Z",
					decisions: [],
					checks: [],
					changedFiles: [],
					pullRequest: null,
					error: null,
					reviewedAt: null,
				};
				const {
					brief: _brief,
					decisions: _decisions,
					checks: _checks,
					changedFiles: _files,
					...summary
				} = job;
				hub.jobs = [
					{ ...summary, ticket: hub.tickets[0] ?? null, pendingDecisions: 0, changedFileCount: 0 },
				];
				return { snapshot: structuredClone(hub), jobId: job.id };
			},
			fixes: unusedPorts,
			approvals: { ...unusedPorts, confirmation: { peek: () => undefined }, service: unexpected },
			prComments: unusedPorts,
			slack: unusedPorts,
			knowledge: unusedPorts,
			daySource: unexpected,
			day: {
				operate: unexpected,
				snapshot: async () => {
					dayReads++;
					await delay(portDelayMs);
					return {
						sequence: 0,
						actor: { workspaceId: "controlled", userId: "controlled" },
						items: [],
						currentItemId: null,
						supervisor: "running",
						errors: [],
					};
				},
			},
		} as unknown as ConversationHubPorts;
		const workspace: ConversationWorkspacePorts = {
			images: unusedPorts as ConversationWorkspacePorts["images"],
			observe: async () => {
				workspaceReads++;
				await delay(portDelayMs);
				return { ...structuredClone(observation), hub: await readHub() };
			},
			execute: async (command, identity, signal, onAction) => {
				assert.equal(command.kind, "open-center");
				const next = structuredClone(observation);
				next.workspace.sequence++;
				next.workspace.canvases = [
					{ id: "tickets", kind: "center", title: "Tickets", section: "tickets", revision: 1 },
				];
				next.workspace.primaryId = "tickets";
				onAction({
					...identity,
					kind: "workspace-canvas",
					screenSequence: observation.workspace.sequence,
					effect: { expectedSequence: observation.workspace.sequence, snapshot: next.workspace },
				});
				const at = performance.now();
				await delay(20);
				signal.throwIfAborted();
				receiptWaitMs += performance.now() - at;
				observation = next;
				return structuredClone(next);
			},
		};
		const outputs = [...scenario.outputs];
		const client: AgentModelClient = {
			async *stream(request: MetaRequest) {
				const output = request.requestId.endsWith(":work-admission")
					? text(
							JSON.stringify({
								intent: "start",
								request: { generation: 1, text: scenario.turns[0] },
								scope: "settled",
								answer: null,
							})
						)
					: outputs.shift();
				assert(output);
				const row = {
					inputBytes: Buffer.byteLength(JSON.stringify(request.input)),
					instructionBytes: Buffer.byteLength(request.instructions),
					toolBytes: Buffer.byteLength(JSON.stringify(request.tools ?? [])),
					toolCount: request.tools?.length ?? 0,
					workload: request.workload,
					requestedAtMs: performance.now() - start,
					firstProviderTextMs: 0,
					terminalMs: 0,
				};
				requests.push(row);
				await delay(20);
				row.firstProviderTextMs = performance.now() - start;
				yield {
					type: "text",
					delta:
						output[0]?.["type"] === "function_call"
							? "Discarded tool prose"
							: String((output[0]?.["content"] as { text: string }[])[0]?.text),
				};
				await delay(40);
				row.terminalMs = performance.now() - start;
				yield {
					type: "completed",
					response: { id: "controlled", model: "muse-spark-1.3", output },
				};
			},
		};
		const service = new ServiceClass(client, {
			hub: hubPorts,
			workspace,
			...(scenario.name === "selected-pr"
				? {
						review: {
							getReady: async () => prepared,
							getProgress: async () => null,
							getScreen: async () => structuredClone(observation.workspace.review),
							navigate: async () => unexpected(),
							getFile: async () => {
								sourceReads++;
								await delay(portDelayMs);
								return {
									prId: pr.id,
									path: "service.ts",
									status: "modified" as const,
									patch: "@@ -1 +1 @@\n-timeout = 1\n+timeout = 2",
									base: {
										path: "service.ts",
										commitSha: pr.baseSha,
										status: "available" as const,
										content: "timeout = 1",
									},
									head: {
										path: "service.ts",
										commitSha: pr.headSha,
										status: "available" as const,
										content: "timeout = 2",
									},
								};
							},
						},
					}
				: {}),
		});
		try {
			start = performance.now();
			for (const [index, question] of scenario.turns.entries()) {
				const input: ConversationTurnInput = {
					sessionId: "probe",
					turnId: `turn-${index}`,
					requestId: `request-${index}`,
					generation: index + 1,
					text: question,
					inputMode: "typed",
					...(scenario.name === "selected-pr" ? { prId: pr.id } : {}),
				};
				service.start(input);
				const deadline = performance.now() + 5000;
				while (true) {
					const result = service.poll({
						sessionId: input.sessionId,
						turnId: input.turnId,
						generation: input.generation,
					});
					if (result.text && firstPublishedMs === null)
						firstPublishedMs = performance.now() - start;
					if (result.status !== "running") {
						assert.equal(
							result.status,
							"completed",
							`${scenario.name}: ${JSON.stringify(result.events)}`
						);
						break;
					}
					assert(performance.now() < deadline, "Probe deadline exceeded");
					await delay(1);
				}
			}
			measurements.push({
				scenario: scenario.name,
				turns: scenario.turns.length,
				modelRounds: requests.length,
				workspaceReads,
				hubReads,
				dayReads,
				ticketReads,
				sourceReads,
				admissions,
				injectedPortDelayMs: portDelayMs,
				contextPortWaitBudgetMs:
					(workspaceReads + hubReads + dayReads + ticketReads + sourceReads) * portDelayMs,
				injectedProviderWaitPerRoundMs: 60,
				receiptWaitMs,
				firstPublishedMs,
				completedMs: performance.now() - start,
				firstAudioMs: null,
				inputTokens: null,
				providerWarmColdIdle: "not-observed",
				requests,
			});
		} finally {
			await service.dispose();
		}
	}
	return measurements;
}

if (import.meta.main) {
	const sourceRoot = resolve(process.argv[2] ?? ".");
	const { ConversationService } = (await import(
		pathToFileURL(resolve(sourceRoot, "apps/desktop/src/main/agent/conversation.ts")).href
	)) as { ConversationService: typeof Service };
	console.log(
		JSON.stringify(
			{
				sourceRevision: process.argv[3] ?? "working-tree",
				controlled: true,
				physicalAudio: false,
				measurements: await probeConversationLatency(ConversationService),
			},
			null,
			2
		)
	);
}
