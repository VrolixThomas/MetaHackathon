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
	TurnIdentitySchema,
} from "../../shared/contracts";
import { acceptBrowserState } from "./browser-session";
import { getScreenContext, useReview } from "./controller";
import { reviewErrorMessage } from "./errors";
import { type AgentAdapter, useServices } from "./services";
import { focusCodeLocation } from "./source-adapter";

type Exchange = { question: string; answer: string; state: string };
export const useConversation = create<{
	history: Exchange[];
	identity: (TurnIdentity & { requestId: string }) | null;
	question: string;
	answer: string;
	state: "idle" | "working" | "complete" | "cancelled" | "error";
	context: string;
	error: string;
}>(() => ({
	identity: null,
	history: [],
	question: "",
	answer: "",
	state: "idle",
	context: "",
	error: "",
}));

type ActiveTurn = {
	unsubscribe?: () => void;
	input: AgentTurnInput;
	controller: AbortController;
	adapter: AgentAdapter;
	sequence: number;
	actions: Set<string>;
	screens: Set<number>;
	external?: boolean;
};
let active: ActiveTurn | null = null;
let generation = 0;
let lastStartedGeneration = -1;
let launchSequence = 0;
export const reviewSessionId = `review-ui-${crypto.randomUUID()}`;
const sessionId = reviewSessionId;

export function allocateReviewTurn(): TurnIdentity {
	return { sessionId, turnId: crypto.randomUUID(), generation: ++generation };
}

function startExchange(question: string, context: string, input: AgentTurnInput) {
	useConversation.setState((state) => ({
		history:
			state.question || state.answer
				? [
						...state.history,
						{ question: state.question, answer: state.answer, state: state.state },
					].slice(-30)
				: state.history,
		identity: {
			sessionId: input.sessionId,
			turnId: input.turnId,
			generation: input.generation,
			requestId: input.requestId,
		},
		question,
		answer: "",
		context,
		state: "working",
		error: "",
	}));
}

function watchScreen(turn: ActiveTurn) {
	turn.unsubscribe = useReview.subscribe((state, previous) => {
		// Observing the same visible page is not reviewer navigation.
		if (
			state.browser !== previous.browser &&
			state.panel === previous.panel &&
			turn.sequence === previous.sequence
		) {
			turn.sequence = state.sequence;
			turn.screens.add(state.sequence);
		}
		if (state.sequence !== previous.sequence && valid(turn) && turn.adapter.updateScreen)
			void turn.adapter
				.updateScreen(sessionId, getScreenContext())
				.catch(() =>
					useReview.getState().announce("The agent could not refresh its screen context.")
				);
	});
}

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
		(action.screenSequence === sequence ||
			(sequence === turn.sequence && turn.screens.has(action.screenSequence)))
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
		case "show-browser": {
			if (acceptBrowserState(action.browser, true)) state.setPanel("browser");
			break;
		}
		case "highlight-code":
			{
				const sequence = useReview.getState().sequence;
				const applied = await focusCodeLocation(
					action.location,
					action.note,
					turn.controller.signal
				);
				if (!valid(turn) || useReview.getState().sequence !== sequence + (applied ? 1 : 0)) return;
			}
			state.setPanel("code");
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
				const sequence = useReview.getState().sequence;
				const applied = await focusCodeLocation(
					step.location,
					`Following scenario, step ${index + 1}`,
					turn.controller.signal
				);
				if (!valid(turn) || useReview.getState().sequence !== sequence + (applied ? 1 : 0)) return;
				useReview.setState((state) => ({ scenarioStepId: step.id, sequence: state.sequence + 1 }));
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
	turn.screens.add(turn.sequence);
}

async function stopActiveQuestion(
	reason: "user" | "escape" | "navigation" | "shutdown" | "push-to-talk" = "user",
	interruptVoice = true
) {
	const turn = active;
	if (!turn) return;
	active = null;
	turn.unsubscribe?.();
	turn.controller.abort();
	if (turn.external && interruptVoice) void useServices.getState().voice?.interrupt(reason);
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
	void useServices.getState().voice?.interrupt("user");
	await stopActiveQuestion();
	if (launch !== launchSequence) return;
	const screenContext = getScreenContext();
	const input: AgentTurnInput = {
		requestId: crypto.randomUUID(),
		...allocateReviewTurn(),
		text: text.trim(),
		screenContext,
	};
	const turn: ActiveTurn = {
		input,
		controller: new AbortController(),
		adapter,
		sequence: screenContext.sequence,
		actions: new Set(),
		screens: new Set([screenContext.sequence]),
	};
	active = turn;
	lastStartedGeneration = input.generation;
	watchScreen(turn);
	startExchange(input.text, screenContext.focusedLocation?.path ?? "Review", input);
	try {
		await adapter.updateScreen?.(sessionId, screenContext);
		if (!valid(turn)) return;
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
			turn.unsubscribe?.();
			useConversation.setState({ state: "complete" });
			active = null;
		}
	} catch (error) {
		if (valid(turn)) {
			turn.unsubscribe?.();
			useConversation.setState({
				state: error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "error",
				error: reviewErrorMessage(error),
			});
			active = null;
		}
	}
}

/** Display/effect sink for a turn already owned by the voice controller. Never calls ask/start. */
export const externalVoiceTurn = {
	begin(identity: TurnIdentity) {
		const parsed = TurnIdentitySchema.parse(identity);
		const adapter = useServices.getState().agent;
		if (!adapter || parsed.sessionId !== sessionId || parsed.generation !== generation)
			return false;
		if (active && sameTurn(active.input, parsed)) return true;
		if (parsed.generation <= lastStartedGeneration) return false;
		lastStartedGeneration = parsed.generation;
		launchSequence++;
		void stopActiveQuestion("push-to-talk", false);
		const screenContext = getScreenContext();
		const turn: ActiveTurn = {
			input: { ...parsed, requestId: crypto.randomUUID(), text: "Voice question", screenContext },
			controller: new AbortController(),
			adapter,
			sequence: screenContext.sequence,
			actions: new Set(),
			screens: new Set([screenContext.sequence]),
			external: true,
		};
		active = turn;
		watchScreen(turn);
		startExchange("Listening…", screenContext.focusedLocation?.path ?? "Review", turn.input);
		return true;
	},
	transcript(identity: TurnIdentity, text: string) {
		if (active?.external && sameTurn(active.input, identity) && valid(active))
			useConversation.setState({ question: text.slice(0, 50_000) });
	},
	text(identity: TurnIdentity, delta: string) {
		if (active?.external && sameTurn(active.input, identity) && valid(active))
			useConversation.setState((state) => ({ answer: (state.answer + delta).slice(0, 50_000) }));
	},
	replaceText(identity: TurnIdentity, text: string) {
		if (active?.external && sameTurn(active.input, identity) && valid(active))
			useConversation.setState({ answer: text.slice(0, 50_000) });
	},
	async action(action: AgentAction) {
		if (active?.external) await applyAction(active, action);
	},
	finish(identity: TurnIdentity, state: "complete" | "cancelled" | "error", error = "") {
		if (!active?.external || !sameTurn(active.input, identity) || !valid(active)) return;
		active.unsubscribe?.();
		active.controller.abort();
		active = null;
		useConversation.setState({ state, error });
	},
};
