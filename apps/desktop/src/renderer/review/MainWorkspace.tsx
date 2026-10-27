import { BrowserWorkspace } from "./BrowserWorkspace";
import { DiffView } from "./DiffView";
import { DiagramArtifact } from "./artifacts/DiagramArtifact";
import { ScenarioArtifact } from "./artifacts/ScenarioArtifact";
import { SignoffArtifact } from "./artifacts/SignoffArtifact";
import { useReview } from "./controller";
import { runLocalScenario, useRuntimeAction } from "./runtime-actions";
import { useServices } from "./services";
import { focusCodeLocation } from "./source-adapter";

export function MainWorkspace({ obscured }: { obscured: boolean }) {
	const state = useReview();
	const {
		panel,
		preparation,
		scenario,
		scenarioIndex,
		diagram,
		drafts,
		files,
		seen,
		setPanel,
		openFile,
	} = state;
	const draftAdapter = useServices((s) => s.drafts);
	const artifacts = useServices((s) => s.artifacts);
	const runtime = useServices((s) => s.runtime);
	const running = useRuntimeAction();
	const surface =
		panel === "preview" ? "browser" : panel === "conversation" || panel === null ? "code" : panel;
	const openSource = async (location: Parameters<typeof focusCodeLocation>[0], note: string) => {
		if (await focusCodeLocation(location, note)) useReview.getState().setPanel("code");
	};
	return (
		<main className="main-workspace" aria-label="Review workspace" data-workspace-surface={surface}>
			<header className="workspace-heading">
				<div>
					<span>
						{preparation.pr.repository} <span className="muted">#{preparation.pr.number}</span>
					</span>
					<strong>{preparation.pr.title}</strong>
				</div>
				<span className="workspace-source">
					{state.sourceMode === "reference" ? "Reference fixture" : "Pinned source"}
				</span>
			</header>
			<nav className="workspace-tabs" aria-label="Main workspace surfaces">
				{(["browser", "code", "scenario", "diagram", "signoff"] as const).map((tab) => (
					<button
						type="button"
						key={tab}
						aria-current={surface === tab ? "page" : undefined}
						className={surface === tab ? "active" : ""}
						onClick={() => setPanel(tab)}
					>
						{
							{
								browser: "Browser",
								code: "Code",
								scenario: "Scenarios",
								diagram: "Diagrams",
								signoff: "Sign-off",
							}[tab]
						}
					</button>
				))}
			</nav>
			<BrowserWorkspace visible={surface === "browser" && !obscured} />
			{surface === "code" && <DiffView />}
			{surface === "scenario" && (
				<div className="main-artifact scenario-panel">
					<div className="main-artifact-heading">
						<h2>Scenario C</h2>
						{state.sourceMode === "repository" && runtime && (
							<button
								type="button"
								className="button"
								disabled={running.busy}
								onClick={() => void runLocalScenario()}
							>
								{running.busy ? running.message : "Run on both revisions"}
							</button>
						)}
					</div>
					{scenario ? (
						<ScenarioArtifact
							trace={scenario}
							selectedIndex={scenarioIndex}
							onSelect={(step, index) => {
								useReview.setState((s) => ({
									scenarioIndex: index,
									scenarioStepId: step.id,
									sequence: s.sequence + 1,
								}));
								void openSource(step.location, `Scenario step ${index + 1}`);
							}}
							onKeepAsTest={
								artifacts?.keepScenarioAsTest
									? () => artifacts.keepScenarioAsTest?.(scenario) ?? Promise.resolve()
									: undefined
							}
							onDraftComment={() => setPanel("signoff")}
						/>
					) : (
						<p className="artifact-note">
							Ask the companion to investigate a scenario, or run scenario C on both revisions.
						</p>
					)}
				</div>
			)}
			{surface === "diagram" && (
				<div className="main-artifact">
					<h2>Codebase context</h2>
					{diagram ? (
						<DiagramArtifact
							diagram={diagram}
							onSelect={(location) => void openSource(location, "Opened from the diagram")}
						/>
					) : (
						<p className="artifact-note">
							Ask how this change connects to the rest of the codebase.
						</p>
					)}
				</div>
			)}
			{surface === "signoff" && (
				<div className="main-artifact">
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
				</div>
			)}
		</main>
	);
}
