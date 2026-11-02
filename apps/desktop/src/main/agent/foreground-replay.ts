/** Public/synthetic replay only. No production composition, store, filesystem, env or native imports.
 * Root may inject a real main-only MetaClient credential closure through replayWithMeta.
 * Outputs are intentionally returned for human quality assessment; production diagnostics stay numeric.
 */
import type {
	ConversationTurnInput,
	HubSnapshot,
	LinearTicket,
	WorkJob,
	WorkspaceObservation,
} from "../../shared/contracts";
import { ConversationService } from "./conversation";
import type { ForegroundTiming } from "./foreground-timing";
import type { ConversationHubPorts } from "./hub-tools";
import {
	type AgentModelClient,
	MetaClient,
	type MetaRequest,
	type ModelTimingRecord,
} from "./meta-client";
import type { ConversationWorkspacePorts } from "./workspace-tools";

export const mixedQuestion =
	"Started working on 77 Openets. Open the ticket for me and talk me through it. What design decisions you need from me before we can start on it.";
export const replayScenarios = [
	{
		name: "mixed-scope",
		selected: false,
		turns: [mixedQuestion, "Make it across refreshes and browser restarts.", "Continue."],
	},
	{
		name: "ordinary",
		selected: true,
		turns: ["Why does remembering focus intent matter?", "What would you recommend for v1?"],
	},
	{
		name: "difficult",
		selected: true,
		turns: [
			"Analyze this ticket deeply: what are the competing failure modes of persistence, expiry and multi-tab behavior, and what is still unknown?",
		],
	},
	{
		name: "implementation-unknown",
		selected: true,
		turns: [
			"Does the existing implementation handle simultaneous tabs correctly? Explain what you have actually inspected.",
		],
	},
] as const;
const time = "2026-11-01T10:00:00Z";
const fail = () => {
	throw new Error("Replay forbids external operations and product mutations");
};
export function createForegroundReplay(
	client: AgentModelClient,
	options: {
		selected?: boolean;
		narrationCheckpoints?: boolean;
		receipt?: () => Promise<void>;
		onTiming?: (event: ForegroundTiming) => void;
	} = {}
) {
	const ticket: LinearTicket = {
		id: "synthetic-ticket",
		identifier: "MET-77",
		title: "Keep focus intent through reloads",
		description:
			"Focus currently turns off after a page refresh. Acceptance: preserve the user's chosen focus state after refresh, keep the active state visible, and let the user turn it off. The lifetime across browser restarts is not decided. Suggested default: device-local persistence. There is no recorded requirement for account sync or automatic expiry. No source has been supplied.",
		url: "https://linear.app/synthetic/issue/MET-77",
		updatedAt: time,
		state: { id: "open", name: "Open", type: "unstarted" },
		priority: 2,
		teamId: "synthetic",
		teamName: "Synthetic",
		projectId: null,
		projectName: null,
		assigneeId: "synthetic",
		assigneeName: "Synthetic",
	};
	const job: WorkJob = {
		id: "synthetic-historical-job",
		ticket,
		repositoryId: "synthetic-repo",
		repository: "synthetic/focus",
		state: "ready",
		branch: "synthetic/prior",
		worktreePath: null,
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
		brief: "Persist focus state across browser restarts on this device.",
		summary: "Prior local candidate is ready; no acceptance or publication has occurred.",
		createdAt: time,
		updatedAt: time,
		decisions: [],
		checks: [],
		changedFiles: [],
		pullRequest: null,
		error: null,
		reviewedAt: null,
	};
	const { description: _description, ...summary } = ticket;
	const {
		brief: _brief,
		decisions: _decisions,
		checks: _checks,
		changedFiles: _changedFiles,
		...jobSummary
	} = job;
	const hub: HubSnapshot = {
		sequence: 1,
		refreshedAt: time,
		refreshing: false,
		viewer: { githubLogin: "synthetic", linearName: "Synthetic" },
		connections: { github: true, linear: true, model: true },
		repositories: [
			{
				id: "synthetic-repo",
				repository: "synthetic/focus",
				localPath: null,
				defaultBranch: "main",
				addedAt: time,
				linearTeamIds: [],
				linearProjectIds: [],
			},
		],
		tickets: [summary],
		reviews: [],
		jobs: [{ ...jobSummary, ticket: summary, pendingDecisions: 0, changedFileCount: 0 }],
		notices: [],
		errors: [],
		preferences: {
			linearTeamIds: [],
			linearProjectIds: [],
			maxWorkers: 1,
			autoApplySuggestions: false,
		},
	};
	let observation: WorkspaceObservation = {
		workspace: {
			sequence: 1,
			contentSequence: 1,
			canvases: [
				{
					id: "tickets",
					kind: "center",
					title: "Tickets",
					section: "tickets",
					...(options.selected ? { selectedId: ticket.id } : {}),
					revision: 1,
				},
			],
			primaryId: "tickets",
			secondaryId: null,
			review: { sequence: 0, mode: "conversation", prId: null },
			codeView: "diff",
			browser: null,
		},
		browser: null,
		reviews: [],
		capabilities: ["center"],
		hub,
	};
	const reads = { workspace: 0, hub: 0, ticket: 0, job: 0, mutations: 0, navigation: 0 };
	let revoked = false;
	const ports: ConversationHubPorts = {
		snapshot: async () => {
			reads.hub++;
			if (revoked) throw new Error("revoked");
			return structuredClone(hub);
		},
		ticket: async (id) => {
			reads.ticket++;
			if (revoked || id !== ticket.id) throw new Error("not authorized");
			return structuredClone(ticket);
		},
		job: async (id) => {
			reads.job++;
			if (revoked || id !== job.id) throw new Error("not authorized");
			return structuredClone(job);
		},
		operate: async () => {
			reads.mutations++;
			return fail();
		},
		feedback: async () => fail(),
		reviewWork: async () => fail(),
		source: async () => fail(),
		search: async () => fail(),
	};
	const workspace: ConversationWorkspacePorts = {
		observe: async () => {
			reads.workspace++;
			return structuredClone(observation);
		},
		execute: async (command, identity, signal, onAction) => {
			if (
				command.kind !== "open-center" ||
				command.section !== "tickets" ||
				(command.selectedId && command.selectedId !== ticket.id)
			)
				return fail();
			reads.navigation++;
			const next = structuredClone(observation);
			next.workspace.sequence++;
			next.workspace.contentSequence = next.workspace.sequence;
			next.workspace.canvases = [
				{
					id: "tickets",
					kind: "center",
					title: "Ticket",
					section: "tickets",
					selectedId: command.selectedId,
					revision: 2,
				},
			];
			onAction({
				...identity,
				kind: "workspace-canvas",
				screenSequence: observation.workspace.sequence,
				effect: { expectedSequence: observation.workspace.sequence, snapshot: next.workspace },
			});
			await options.receipt?.();
			signal.throwIfAborted();
			observation = next;
			return structuredClone(observation);
		},
	};
	const requests: MetaRequest[] = [];
	const service = new ConversationService(
		{
			async *stream(request, signal) {
				requests.push(structuredClone(request));
				if (requests.length > 24) throw new Error("Replay request budget exhausted");
				yield* client.stream(request, signal);
			},
		},
		{
			workspace,
			hub: ports,
			onTiming: options.onTiming,
			narrationCheckpoints: options.narrationCheckpoints,
		}
	);
	let generation = 0;
	const startedAt = new Map<number, number>();
	return {
		service,
		requests,
		reads,
		ticket,
		job,
		revoke: () => {
			revoked = true;
		},
		changeContent: () => {
			observation.workspace.sequence++;
			observation.workspace.contentSequence = observation.workspace.sequence;
		},
		start(text: string) {
			generation++;
			const input: ConversationTurnInput = {
				sessionId: "synthetic-replay",
				turnId: `turn-${generation}`,
				requestId: `request-${generation}`,
				generation,
				text,
				inputMode: "typed",
			};
			startedAt.set(generation, performance.now());
			service.start(input);
			return input;
		},
		async settle(input: ConversationTurnInput, timeoutMs = 120_000) {
			const start = startedAt.get(input.generation) ?? performance.now();
			let firstPublishedMs: number | null = null;
			while (performance.now() - start < timeoutMs) {
				const result = service.poll(identity(input));
				if (result.text && firstPublishedMs === null)
					firstPublishedMs = Math.round(performance.now() - start);
				if (result.status !== "running")
					return { result, firstPublishedMs, durationMs: Math.round(performance.now() - start) };
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
			service.cancel({
				...identity(input),
				requestId: `cancel-${input.generation}`,
				reason: "user",
			});
			throw new Error("Replay deadline exceeded");
		},
	};
}

export async function replayForeground(client: AgentModelClient) {
	const reports = [];
	for (const scenario of replayScenarios) {
		const timings: ForegroundTiming[] = [];
		const h = createForegroundReplay(client, {
			selected: scenario.selected,
			onTiming: (row) => timings.push(row),
		});
		const turns = [];
		try {
			for (const text of scenario.turns) {
				const before = h.requests.length;
				const output = await h.settle(h.start(text));
				turns.push({
					question: text,
					output: output.result.text,
					status: output.result.status,
					firstPublishedMs: output.firstPublishedMs,
					durationMs: output.durationMs,
					modelRequests: h.requests.length - before,
					requests: h.requests.slice(before).map((request) => ({
						workload: request.workload,
						toolCount: request.tools?.length ?? 0,
						inputBytes: Buffer.byteLength(JSON.stringify(request.input)),
						instructionBytes: Buffer.byteLength(request.instructions),
					})),
				});
			}
			reports.push({
				scenario: scenario.name,
				turns,
				timings,
				reads: h.reads,
				firstPCM: null,
				syntheticContext: true,
			});
		} finally {
			await h.service.dispose();
		}
	}
	return reports;
}

/** Root-only live option. This module never looks up credentials or loads .env itself. */
export async function replayWithMeta(getApiKey: () => Promise<string | null>) {
	const modelTimings: ModelTimingRecord[] = [];
	const client = new MetaClient({
		getApiKey,
		recordUsage: () => {},
		recordTiming: (row) => modelTimings.push(row),
		timeoutMs: 90_000,
	});
	return {
		transport: "live-meta-text",
		syntheticContext: true,
		physicalAudio: false,
		reports: await replayForeground(client),
		modelTimings,
	};
}

function identity(input: { sessionId: string; turnId: string; generation: number }) {
	return { sessionId: input.sessionId, turnId: input.turnId, generation: input.generation };
}

/** Fixed waits exercise orchestration, not provider intelligence or acoustic latency. */
export async function replayControlled() {
	const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	const controlled: AgentModelClient = {
		async *stream(request) {
			const functions = request.tools ?? [];
			const name =
				functions.length === 1 && functions[0]?.name === "open_command_center"
					? "open_command_center"
					: request.workload === "quick" &&
							JSON.stringify(request.input).includes("Analyze this ticket deeply")
						? "analyze_current_context"
						: null;
			const text = "CONTROLLED REPLAY: no answer quality claim. Which lifetime?";
			await pause(20);
			yield { type: "text", delta: name ? "Discard this speculative prose." : text };
			await pause(80);
			yield {
				type: "completed",
				response: {
					id: "controlled",
					model: request.workload === "quick" ? "muse-spark-1.3" : "muse-wonder-1.0",
					output: name
						? [
								{
									type: "function_call",
									name,
									call_id: `controlled-${name}`,
									status: "completed",
									arguments: JSON.stringify(
										name === "open_command_center"
											? { section: "tickets", selectedId: "synthetic-ticket" }
											: { question: "Compare failure modes and unknowns" }
									),
								},
							]
						: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
				},
			};
		},
	};
	return {
		transport: "controlled",
		injectedFirstTextWaitMs: 20,
		injectedTerminalTailMs: 80,
		physicalAudio: false,
		reports: await replayForeground(controlled),
	};
}

if (import.meta.main) console.log(JSON.stringify(await replayControlled(), null, 2));
