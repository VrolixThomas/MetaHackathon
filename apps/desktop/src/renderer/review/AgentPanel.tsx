import { Icon } from "./Icons";
import { useReview } from "./controller";
import type { Artifact } from "./model";

const titles: Record<Artifact, string> = {
	conversation: "Review companion",
	scenario: "Scenario C",
	preview: "Checkout preview",
	diagram: "Codebase context",
	signoff: "Review sign-off",
};

export function AgentPanel() {
	const { panel, setPanel, file, announce } = useReview();
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
						onClick={() => setPanel(tab)}
					>
						{tab === "conversation" ? "Ask" : tab === "scenario" ? "Scenario C" : "Preview"}
					</button>
				))}
			</nav>
			<div className="panel-scroll">
				<div className="exchange-label">You · reference prompt</div>
				<p className="user-words">
					{panel === "scenario"
						? "What happens in scenario C? Show me."
						: panel === "preview"
							? "Show me the checkout when the cap applies."
							: "What should I look at here?"}
				</p>
				<p className="agent-answer">
					{panel === "scenario"
						? "The nightly job hits an expired code. Both versions follow the same path until step 4. Then they split."
						: panel === "preview"
							? "A Platinum shopper, VIP30, and a €120 cart. On a phone, the cap note wraps and Pay moves below the fold."
							: "Start with the discount rule. Follow the change through the order, then check the checkout states. The expired-code path needs a closer look."}
				</p>
				<span className="evidence-label">
					<span className="dot amber" />
					Reference fixture · not an executed result
				</span>
				{panel === "conversation" && (
					<>
						<p className="artifact-note">
							In context: <code>{file}</code>. Live agent responses are pending the agent adapter.
						</p>
						<div className="suggestions">
							<button type="button" onClick={() => setPanel("scenario")}>
								Show me scenario C <Icon name="arrow" size={14} />
							</button>
							<button type="button" onClick={() => setPanel("preview")}>
								Show the phone checkout <Icon name="arrow" size={14} />
							</button>
						</div>
					</>
				)}
				{panel !== "conversation" && (
					<p className="artifact-note">Shared artifact data is being connected.</p>
				)}
			</div>
			<form
				className="panel-composer"
				onSubmit={(event) => {
					event.preventDefault();
					const input = event.currentTarget.elements.namedItem("question");
					if (input instanceof HTMLInputElement && input.value.trim()) {
						announce(
							"The live agent is not connected. Use Scenario C or Preview to explore the labeled fixtures."
						);
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
