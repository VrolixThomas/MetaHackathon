import { create } from "zustand";
import type {
	AgentAction,
	AgentTurnInput,
	CancelTurnInput,
	CodeLocation,
	ConfirmCommentInput,
	CredentialProvider,
	CredentialStatus,
	DiagramSpec,
	DraftedComment,
	Preview,
	PullRequest,
	ScenarioTrace,
	ScreenContext,
	SourceFile,
	SourceFileRequest,
} from "../../shared/contracts";

export type { CredentialProvider, CredentialStatus } from "../../shared/contracts";
/** Runtime composition port: deliberately exposes no key getter. */
export type SettingsAdapter = {
	status: () => Promise<CredentialStatus[]>;
	set: (provider: CredentialProvider, value: string) => Promise<void>;
	remove: (provider: CredentialProvider) => Promise<void>;
	signInGitHub: () => Promise<void>;
};
export type VoiceAdapter = {
	beginCapture: () => void | Promise<void>;
	endCapture: () => void | Promise<void>;
	interrupt: () => void | Promise<void>;
	getPhase: () => string;
	subscribe: (listener: () => void) => () => void;
};
export type AgentAdapter = {
	updateScreen?: (sessionId: string, screenContext: ScreenContext) => Promise<void>;
	ask: (
		input: AgentTurnInput,
		observer: {
			text: (delta: string) => void;
			replaceText: (text: string) => void;
			action: (action: AgentAction) => Promise<void>;
		},
		signal: AbortSignal
	) => Promise<void>;
	cancel: (input: CancelTurnInput) => Promise<void>;
	getScenario: (id: string) => Promise<ScenarioTrace>;
	getPreview: (id: string) => Promise<Preview>;
	getDiagram: (id: string) => Promise<DiagramSpec>;
};
export type ArtifactAdapter = {
	resizePreview: (
		preview: Preview,
		mode: "phone" | "desktop",
		signal?: AbortSignal
	) => Promise<Preview>;
	keepScenarioAsTest?: (scenario: ScenarioTrace) => Promise<void>;
	draftComment?: (originalWords: string, location: CodeLocation | null) => Promise<DraftedComment>;
};
export type DraftAdapter = {
	edit: (draftId: string, body: string) => Promise<DraftedComment>;
	confirm: (input: ConfirmCommentInput) => Promise<{ url: string }>;
};
export type SourceAdapter = { read: (request: SourceFileRequest) => Promise<SourceFile> };
export type RuntimeAdapter = {
	prepareDemo: () => Promise<PullRequest[]>;
	changedFiles: (prId: string) => Promise<string[]>;
	runScenario: (
		prId: string,
		scenarioId: "A" | "B" | "C" | "D",
		signal?: AbortSignal
	) => Promise<ScenarioTrace>;
	startPreview: (prId: string, mode: "phone" | "desktop", signal?: AbortSignal) => Promise<Preview>;
	stopPreview: (id: string) => Promise<void>;
};
export const useServices = create<{
	settings: SettingsAdapter | null;
	voice: VoiceAdapter | null;
	agent: AgentAdapter | null;
	artifacts: ArtifactAdapter | null;
	drafts: DraftAdapter | null;
	sources: SourceAdapter | null;
	runtime: RuntimeAdapter | null;
}>(() => ({
	settings: null,
	voice: null,
	agent: null,
	artifacts: null,
	drafts: null,
	sources: null,
	runtime: null,
}));
export function configureReviewServices(
	services: Partial<ReturnType<typeof useServices.getState>>
) {
	useServices.setState(services);
}
