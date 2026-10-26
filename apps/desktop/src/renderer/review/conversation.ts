import { create } from "zustand";
import {
	type AgentAction,
	AgentActionSchema,
	type AgentTurnInput,
	DiagramSpecSchema,
	DraftedCommentSchema,
	PreviewSchema,
	ScenarioTraceSchema,
	type TurnIdentity,
} from "../../shared/contracts";
import { getScreenContext, useReview } from "./controller";
import { type AgentAdapter, useServices } from "./services";
import { focusCodeLocation } from "./source-adapter";

export const useConversation = create<{
	question: string;
	answer: string;
	state: "idle" | "working" | "complete" | "cancelled" | "error";
	context: string;
	error: string;
}>(() => ({ question: "", answer: "", state: "idle", context: "", error: "" }));

type ActiveTurn = {
	input: AgentTurnInput;
	controller: AbortController;
	adapter: AgentAdapter;
	sequence: number;
	actions: Set<string>;
};
let active: ActiveTurn | null = null;
let generation = 0;
let launchSequence = 0;
const sessionId = `review-ui-${crypto.randomUUID()}`;

function locationMatchesReview(location: {
	repository: string;
	revision: "base" | "head";
	commitSha: string;
}) {
	const pr = useReview.getState().preparation.pr;
	return (
		location.repository === pr.repository &&
		location.commitSha === (location.revision === "base" ? pr.baseSha : pr.headSha)
	);
}

function sameTurn(a: TurnIdentity, b: TurnIdentity) {
	return a.sessionId === b.sessionId && a.turnId === b.turnId && a.generation === b.generation;
}
function valid(turn: ActiveTurn) {
	return active === turn && !turn.controller.signal.aborted;
}
function currentScreen(turn: ActiveTurn, action: AgentAction) {
	const sequence = useReview.getState().sequence;
	return (
		valid(turn) &&
		sequence === turn.sequence &&
		(action.screenSequence === sequence ||
			action.screenSequence === turn.input.screenContext.sequence)
	);
}

/** Reject late generations, duplicate effects and references to a screen the reviewer has left. */
async function applyAction(turn: ActiveTurn, input: AgentAction) {
	const action = AgentActionSchema.parse(input);
	if (
		!sameTurn(action, turn.input) ||
		!currentScreen(turn, action) ||
		turn.actions.has(action.requestId)
	)
		return;
	turn.actions.add(action.requestId);
	const state = useReview.getState();
	switch (action.kind) {
		case "highlight-code":
			await focusCodeLocation(action.location, action.note);
			break;
		case "show-scenario": {
			const scenario = ScenarioTraceSchema.parse(await turn.adapter.getScenario(action.scenarioId));
			if (
				!currentScreen(turn, action) ||
				scenario.id !== action.scenarioId ||
				scenario.prId !== state.preparation.pr.id ||
				scenario.before.commitSha !== state.preparation.pr.baseSha ||
				scenario.after.commitSha !== state.preparation.pr.headSha ||
				[...scenario.before.steps, ...scenario.after.steps].some(
					(step) => !locationMatchesReview(step.location)
				)
			)
				return;
			const index = scenario.divergenceIndex ?? 0;
			useReview.setState({ scenario, scenarioIndex: index });
			state.setPanel("scenario");
			const step = scenario.after.steps[index];
			if (step) {
				await focusCodeLocation(step.location, `Following scenario, step ${index + 1}`);
				useReview.setState({ scenarioStepId: step.id });
			}
			break;
		}
		case "show-preview": {
			const preview = PreviewSchema.parse(await turn.adapter.getPreview(action.previewId));
			if (
				!currentScreen(turn, action) ||
				preview.id !== action.previewId ||
				preview.prId !== state.preparation.pr.id ||
				preview.commitSha !==
					(preview.revision === "base"
						? state.preparation.pr.baseSha
						: state.preparation.pr.headSha) ||
				preview.markers.some((marker) => !locationMatchesReview(marker.location))
			)
				return;
			useReview.setState({ preview });
			state.setPanel("preview");
			break;
		}
		case "show-diagram": {
			const diagram = DiagramSpecSchema.parse(await turn.adapter.getDiagram(action.diagramId));
			if (
				!currentScreen(turn, action) ||
				diagram.id !== action.diagramId ||
				diagram.prId !== state.preparation.pr.id ||
				diagram.nodes.some((node) => !locationMatchesReview(node.location))
			)
				return;
			useReview.setState({ diagram });
			state.setPanel("diagram");
			break;
		}
		case "draft-comment": {
			const draft = DraftedCommentSchema.parse(action.draft);
			if (draft.prId !== state.preparation.pr.id || draft.headSha !== state.preparation.pr.headSha)
				return;
			useReview.setState({ drafts: [...state.drafts.filter((d) => d.id !== draft.id), draft] });
			state.announce("Comment drafted. Review its wording and confirm at sign-off before posting.");
			break;
		}
		case "run-scenario":
			state.announce("Scenario requested. Waiting for the agent's runtime result.");
			break;
	}
	turn.sequence = useReview.getState().sequence;
}

async function stopActiveQuestion(
	reason: "user" | "escape" | "navigation" | "shutdown" | "push-to-talk" = "user"
) {
	const turn = active;
	if (!turn) return;
	active = null;
	turn.controller.abort();
	useConversation.setState({ state: "cancelled" });
	try {
		await turn.adapter.cancel({
			requestId: crypto.randomUUID(),
			sessionId: turn.input.sessionId,
			turnId: turn.input.turnId,
			generation: turn.input.generation,
			reason,
		});
	} catch {
		useReview
			.getState()
			.announce("The reply is stopped locally. The runtime did not acknowledge cancellation.");
	}
}

export function cancelActiveQuestion(
	reason: "user" | "escape" | "navigation" | "shutdown" | "push-to-talk" = "user"
) {
	launchSequence++;
	return stopActiveQuestion(reason);
}

export async function runAgentQuestion(text: string) {
	const adapter = useServices.getState().agent;
	if (!adapter) {
		useReview
			.getState()
			.announce("The live agent is not connected. Explore the labeled reference artifacts below.");
		return;
	}
	if (!text.trim()) return;
	const launch = ++launchSequence;
	await stopActiveQuestion();
	if (launch !== launchSequence) return;
	const screenContext = getScreenContext();
	const input: AgentTurnInput = {
		requestId: crypto.randomUUID(),
		sessionId,
		turnId: crypto.randomUUID(),
		generation: ++generation,
		text: text.trim(),
		screenContext,
	};
	const turn: ActiveTurn = {
		input,
		controller: new AbortController(),
		adapter,
		sequence: screenContext.sequence,
		actions: new Set(),
	};
	active = turn;
	useConversation.setState({
		question: input.text,
		answer: "",
		state: "working",
		context: screenContext.focusedLocation?.path ?? "Review",
		error: "",
	});
	try {
		await adapter.ask(
			input,
			{
				text: (delta) => {
					if (valid(turn))
						useConversation.setState((state) => ({
							answer: (state.answer + delta).slice(0, 50_000),
						}));
				},
				replaceText: (text) => {
					if (valid(turn)) useConversation.setState({ answer: text.slice(0, 50_000) });
				},
				action: (action) => applyAction(turn, action),
			},
			turn.controller.signal
		);
		if (valid(turn)) {
			useConversation.setState({ state: "complete" });
			active = null;
		}
	} catch (error) {
		if (valid(turn)) {
			useConversation.setState({
				state: error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "error",
				error:
					"The agent could not complete this reply. Try again when the connection is available.",
			});
			active = null;
		}
	}
}
