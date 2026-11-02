/** Controlled production-orchestration probe. No native app, provider, credentials or audio. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	ConversationTurnInput,
	HubSnapshot,
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
	const measurements = [];
	for (const scenario of scenarios) {
		let workspaceReads = 0;
		let hubReads = 0;
		let dayReads = 0;
		let receiptWaitMs = 0;
		let start = 0;
		let firstPublishedMs: number | null = null;
		const requests: Array<{
			inputBytes: number;
			instructionBytes: number;
			toolBytes: number;
			toolCount: number;
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
		const hubPorts = {
			...Object.fromEntries(
				["operate", "ticket", "job", "jobLog", "feedback", "reviewWork", "source", "search"].map(
					(key) => [key, unexpected]
				)
			),
			snapshot: readHub,
			fixes: unusedPorts,
			approvals: unusedPorts,
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
				const output = outputs.shift();
				assert(output);
				const row = {
					inputBytes: Buffer.byteLength(JSON.stringify(request.input)),
					instructionBytes: Buffer.byteLength(request.instructions),
					toolBytes: Buffer.byteLength(JSON.stringify(request.tools ?? [])),
					toolCount: request.tools?.length ?? 0,
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
		const service = new ServiceClass(client, { hub: hubPorts, workspace });
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
						assert.equal(result.status, "completed", JSON.stringify(result.events));
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
				injectedPortDelayMs: portDelayMs,
				contextPortWaitBudgetMs: (workspaceReads + hubReads + dayReads) * portDelayMs,
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
