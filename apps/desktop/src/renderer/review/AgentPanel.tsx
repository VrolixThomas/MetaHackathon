import { Icon } from "./Icons";
import { PreviewArtifact } from "./artifacts/PreviewArtifact";
import { ScenarioArtifact } from "./artifacts/ScenarioArtifact";
import { highlightLocation, openReviewArtifact, useReview } from "./controller";
import { cancelActiveQuestion, runAgentQuestion, useConversation } from "./conversation";
import type { Artifact } from "./model";
import { useServices } from "./services";

const titles: Record<Artifact, string> = {
	conversation: "Review companion",
	scenario: "Scenario C",
	preview: "Checkout preview",
	diagram: "Codebase context",
	signoff: "Review sign-off",
};

export function AgentPanel() {
	const { panel, setPanel, file, scenario, scenarioIndex, preview, preparation } = useReview();
	const conversation = useConversation();
	const artifacts = useServices((state) => state.artifacts);
	const isFixture = preparation.evidence.kind === "fixture";
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
				{(["conversation", "scenario", "preview"] as const).map((tab) => (
					<button
						type="button"
						key={tab}
						className={panel === tab ? "active" : ""}
						onClick={() => openReviewArtifact(tab)}
					>
						{tab === "conversation" ? "Ask" : tab === "scenario" ? "Scenario C" : "Preview"}
					</button>
				))}
			</nav>
			<div className="panel-scroll">
				<div className="exchange-label">{conversation.question ? "You" : "Reference prompt"}</div>
				<p className="user-words">
					{conversation.question ||
						(panel === "scenario"
							? "What happens in scenario C? Show me."
							: panel === "preview"
								? "Show me the checkout when the cap applies."
								: "What should I look at here?")}
				</p>
				<p className="agent-answer">
					{conversation.question
						? conversation.answer ||
							(conversation.state === "working"
								? "Looking at the code in context…"
								: "No response yet.")
						: panel === "scenario"
							? "The nightly job hits an expired code. Both versions follow the same path until step 4. Then they split."
							: panel === "preview"
								? "A Platinum shopper, VIP30, and a €120 cart. On a phone, the cap note wraps and Pay moves below the fold."
								: "Start with the discount rule. Follow the change through the order, then check the checkout states. The expired-code path needs a closer look."}
				</p>
				{isFixture && (
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
				{panel === "conversation" && (
					<>
						<p className="artifact-note">
							In context: <code>{file}</code>. Live agent responses are pending the agent adapter.
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
								highlightLocation(
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
								highlightLocation(marker.location, `Marker ${marker.number}: ${marker.label}`);
							}}
							onViewportChange={
								artifacts
									? async (mode) => {
											const refreshed = await artifacts.resizePreview(preview, mode);
											useReview.setState({ preview: refreshed });
											return refreshed;
										}
									: undefined
							}
						/>
					) : (
						<p className="artifact-note">No preview is available for this review.</p>
					))}
				{(panel === "signoff" || panel === "diagram") && (
					<p className="artifact-note">This interface follows the Must scope.</p>
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
