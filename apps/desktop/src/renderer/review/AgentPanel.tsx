import { Icon } from "./Icons";
import { DiagramArtifact } from "./artifacts/DiagramArtifact";
import { PreviewArtifact } from "./artifacts/PreviewArtifact";
import { ScenarioArtifact } from "./artifacts/ScenarioArtifact";
import { SignoffArtifact } from "./artifacts/SignoffArtifact";
import { openReviewArtifact, useReview } from "./controller";
import { cancelActiveQuestion, runAgentQuestion, useConversation } from "./conversation";
import type { Artifact } from "./model";
import { resizeActivePreview } from "./preview-session";
import { runLocalScenario, startLocalPreview, useRuntimeAction } from "./runtime-actions";
import { useServices } from "./services";
import { focusCodeLocation } from "./source-adapter";

const titles: Record<Artifact, string> = {
	conversation: "Review companion",
	scenario: "Scenario C",
	preview: "Checkout preview",
	diagram: "Codebase context",
	signoff: "Review sign-off",
};

export function AgentPanel() {
	const {
		sourceMode,
		panel,
		setPanel,
		file,
		scenario,
		scenarioIndex,
		preview,
		diagram,
		drafts,
		files,
		seen,
		openFile,
		preparation,
	} = useReview();
	const conversation = useConversation();
	const copy = panelCopy(preparation, sourceMode, panel, conversation);
	const artifacts = useServices((state) => state.artifacts);
	const draftAdapter = useServices((state) => state.drafts);
	const isFixture = sourceMode === "reference" && preparation.evidence.kind === "fixture";
	const runtime = useServices((state) => state.runtime);
	const agent = useServices((state) => state.agent);
	const runtimeAction = useRuntimeAction();
	const isOpen = panel !== null;
	useEffect(() => {
		if (!isOpen) return;
		const opener = document.activeElement;
		return () => {
			if (opener instanceof HTMLElement && opener.isConnected)
				opener.focus({ preventScroll: true });
			else
				document
					.querySelector<HTMLButtonElement>("[data-agent-trigger]")
					?.focus({ preventScroll: true });
		};
	}, [isOpen]);
	if (!panel) return null;
	return (
		<aside className="agent-panel" aria-label={titles[panel]}>
			<header className="panel-header">
				<span className="dot blue" />
				<strong>{titles[panel]}</strong>
				<span>contextual agent</span>
				<kbd>esc</kbd>
				<button
					type="button"
					className="icon-button"
					aria-label="Close agent panel"
					onClick={() => setPanel(null)}
				>
					<Icon name="close" size={16} />
				</button>
			</header>
			<nav className="panel-tabs" aria-label="Artifacts">
				{(["conversation", "scenario", "preview", "diagram"] as const).map((tab) => (
					<button
						type="button"
						key={tab}
						className={panel === tab ? "active" : ""}
						onClick={() => openReviewArtifact(tab)}
					>
						{
							{
								conversation: "Ask",
								scenario: "Scenario C",
								preview: "Preview",
								diagram: "Context",
							}[tab]
						}
					</button>
				))}
			</nav>
			<div
				className={`panel-scroll ${panel === "scenario" ? "scenario-panel" : ""} ${panel !== "conversation" ? "artifact-panel" : ""}`}
			>
				{panel !== "signoff" && (
					<>
						<div className="exchange-label">{copy.label}</div>
						<p className="user-words">{copy.question}</p>
						<p className="agent-answer">{copy.answer}</p>
					</>
				)}
				{isFixture && panel === "conversation" && (
					<span className="evidence-label">
						<span className="dot amber" />
						Reference fixture · not an executed result
					</span>
				)}
				{conversation.error && (
					<p className="artifact-note" role="alert">
						{conversation.error}
					</p>
				)}
				{conversation.state === "working" && (
					<button type="button" className="text-button" onClick={() => void cancelActiveQuestion()}>
						Stop reply
					</button>
				)}
				{sourceMode === "repository" && runtime && (
					<div className="runtime-artifact-actions">
						<button
							type="button"
							className="button"
							disabled={runtimeAction.busy}
							onClick={() => void runLocalScenario()}
						>
							Run scenario C
						</button>
						<button
							type="button"
							className="button"
							disabled={runtimeAction.busy}
							onClick={() => void startLocalPreview()}
						>
							Open live preview
						</button>
						{runtimeAction.busy && <output>{runtimeAction.message}</output>}
					</div>
				)}
				{panel === "conversation" && (
					<>
						<p className="artifact-note">
							In context: <code>{file}</code>.{" "}
							{agent
								? "This context accompanies your question."
								: "Live agent replies are not connected."}
						</p>
						<div className="suggestions">
							<button type="button" onClick={() => openReviewArtifact("scenario")}>
								Show me scenario C <Icon name="arrow" size={14} />
							</button>
							<button type="button" onClick={() => openReviewArtifact("preview")}>
								Show the phone checkout <Icon name="arrow" size={14} />
							</button>
						</div>
					</>
				)}
				{panel === "scenario" &&
					(scenario ? (
						<ScenarioArtifact
							key={scenario.id}
							trace={scenario}
							selectedIndex={scenarioIndex}
							onSelect={(step, index) => {
								useReview.setState((state) => ({
									scenarioIndex: index,
									scenarioStepId: step.id,
									sequence: state.sequence + 1,
								}));
								void focusCodeLocation(
									step.location,
									`Following scenario C, step ${index + 1} · ${step.location.revision === "base" ? "before" : "this PR"}`
								);
							}}
							onKeepAsTest={
								artifacts?.keepScenarioAsTest
									? () => artifacts.keepScenarioAsTest?.(scenario) ?? Promise.resolve()
									: undefined
							}
							onDraftComment={() => setPanel("signoff")}
						/>
					) : (
						<p className="artifact-note">No scenario result is available for this review.</p>
					))}
				{panel === "preview" &&
					(preview ? (
						<PreviewArtifact
							preview={preview}
							onSelect={(marker) => {
								useReview.setState((state) => ({
									previewMarkerId: marker.id,
									sequence: state.sequence + 1,
								}));
								void focusCodeLocation(marker.location, `Marker ${marker.number}: ${marker.label}`);
							}}
							onViewportChange={
								artifacts ? (mode) => resizeActivePreview(artifacts, mode) : undefined
							}
						/>
					) : (
						<p className="artifact-note">No preview is available for this review.</p>
					))}
				{panel === "diagram" &&
					(diagram ? (
						<DiagramArtifact
							diagram={diagram}
							onSelect={(location) => void focusCodeLocation(location, "Opened from the diagram")}
						/>
					) : (
						<p className="artifact-note">No codebase diagram is available for this review.</p>
					))}
				{panel === "signoff" && (
					<SignoffArtifact
						preparation={preparation}
						files={files}
						seen={seen}
						drafts={drafts}
						onOpenFile={openFile}
						adapter={draftAdapter}
						onDraftChange={(draft) =>
							useReview.setState((current) =>
								draft.prId === current.preparation.pr.id &&
								draft.headSha === current.preparation.pr.headSha
									? {
											drafts: current.drafts.map((existing) =>
												existing.id === draft.id && draft.revision > existing.revision
													? draft
													: existing
											),
										}
									: {}
							)
						}
					/>
				)}
			</div>
			<form
				className="panel-composer"
				onSubmit={(event) => {
					event.preventDefault();
					const input = event.currentTarget.elements.namedItem("question");
					if (input instanceof HTMLInputElement && input.value.trim()) {
						void runAgentQuestion(input.value);
						input.value = "";
					}
				}}
			>
				<Icon name="agent" size={15} />
				<input
					name="question"
					aria-label="Ask about the current code"
					placeholder="Ask about this code…"
				/>
				<button type="submit" aria-label="Send question">
					<Icon name="arrow" size={16} />
				</button>
			</form>
		</aside>
	);
}
import { useEffect } from "react";
import { panelCopy } from "./panel-copy";
