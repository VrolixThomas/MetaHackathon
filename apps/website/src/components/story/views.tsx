"use client";
import { reviewFiles } from "@/lib/story";
import { Brand } from "../brand";
import { Icon } from "../icons";
import { useStory } from "./context";

function SourceLabel({
	source,
	children,
}: { source: "linear" | "github" | "slack"; children: React.ReactNode }) {
	return (
		<span className="source-label">
			<Icon name={source} size={13} />
			{children}
		</span>
	);
}
function Code({ lines, added = false }: { lines: readonly string[]; added?: boolean }) {
	return (
		<pre className="story-code" aria-label="Illustrative code">
			<code>
				{lines.map((line, index) => (
					<span
						className={`code-line ${added && index > 0 && index < lines.length - 1 ? "added" : ""}`}
						key={`${index}-${line}`}
					>
						<span className="line-number" aria-hidden="true">
							{index + 12}
						</span>
						<span>{line}</span>
					</span>
				))}
			</code>
		</pre>
	);
}
function Discussion({ question, children }: { question: string; children: React.ReactNode }) {
	return (
		<div className="discussion">
			<span className="micro-label">A conversation could start here</span>
			<p className="discussion-question">“{question}”</p>
			<div className="discussion-answer">
				<Brand name={false} size={26} />
				<p>{children}</p>
			</div>
			<span className="discussion-footnote">Scripted discussion example</span>
		</div>
	);
}

export function PlanView() {
	const { state, dispatch } = useStory();
	return (
		<div className="plan-view">
			<SourceLabel source="linear">ENG-142 · Session recovery</SourceLabel>
			<div className="ticket-brief">
				<span className="micro-label">The ticket</span>
				<p>“Let me reopen a workspace and pick up where I left off.”</p>
			</div>
			<div className="scope-question">
				<div className="scope-question-heading">
					<Brand name={false} size={24} />
					<span>One decision before the first pass.</span>
				</div>
				<fieldset>
					<legend>What should come back when you reopen it?</legend>
					<div className="scope-options">
						<button
							type="button"
							aria-pressed={state.planScope === "position"}
							onClick={() => dispatch({ type: "scope", scope: "position" })}
						>
							<span className="choice-ring" />
							<span>
								<strong>Files + review position</strong>
								<small>Start with the place I was reviewing.</small>
							</span>
						</button>
						<button
							type="button"
							aria-pressed={state.planScope === "layout"}
							onClick={() => dispatch({ type: "scope", scope: "layout" })}
						>
							<span className="choice-ring" />
							<span>
								<strong>The working layout, too</strong>
								<small>Keep my open panes and their arrangement.</small>
							</span>
						</button>
					</div>
				</fieldset>
			</div>
			<div className={`v1-brief ${state.planScope ? "is-defined" : ""}`} aria-live="polite">
				<Icon name={state.planScope ? "check" : "spark"} size={15} />
				<div>
					<strong>
						{state.planScope ? "A clearer first pass" : "Your judgment sets the direction"}
					</strong>
					<p>
						{state.planScope === "layout"
							? "Remember files, review position and the pane layout. Bring the implementation back for review."
							: state.planScope === "position"
								? "Remember the review position per workspace. Keep the first pass small and bring the implementation back for review."
								: "Choose an answer to see how a useful implementation brief takes shape."}
					</p>
				</div>
			</div>
		</div>
	);
}

export function ReviewView() {
	const { state, dispatch } = useStory();
	const file = reviewFiles[state.file] ?? reviewFiles[0];
	return (
		<div className="review-view">
			<SourceLabel source="github">PR #28 · A teammate’s review progress change</SourceLabel>
			<div className="review-layout">
				<div className="reading-order">
					<span className="micro-label">Reading order</span>
					<ol>
						{reviewFiles.map((item, index) => (
							<li key={item.path}>
								<button
									type="button"
									onClick={() => dispatch({ type: "file", file: index })}
									aria-current={state.file === index ? "step" : undefined}
								>
									<span className="file-order-number">0{index + 1}</span>
									<span>
										<strong>{item.label}</strong>
										<small>{item.path.split("/").at(-1)}</small>
									</span>
								</button>
							</li>
						))}
					</ol>
					<span className="order-note">From entry point to persistence.</span>
				</div>
				<div className="review-detail">
					<div className="file-bar">
						<Icon name="code" size={13} />
						<span>{file.path}</span>
						<span className="example-tag">Example</span>
					</div>
					<p className="file-context">{file.why}</p>
					{state.discussion ? (
						<Discussion question="How does this fit the bigger ticket?">
							The goal is to resume the same review, with the same source context. This part saves
							the checkpoint; the entry point and preparation step use it to decide where to reopen.
						</Discussion>
					) : (
						<Code lines={file.code} />
					)}
					<button
						className="conversation-trigger"
						type="button"
						aria-expanded={state.discussion}
						onClick={() => dispatch({ type: "discussion", open: !state.discussion })}
					>
						<Icon name={state.discussion ? "code" : "chat"} size={14} />
						{state.discussion ? "Back to the code" : "Ask about the bigger picture"}
						<span aria-hidden="true">↗</span>
					</button>
				</div>
			</div>
		</div>
	);
}

export function FlowGraphic({ compact = false }: { compact?: boolean }) {
	return (
		<div
			className={`flow-graphic ${compact ? "compact" : ""}`}
			aria-label="Illustrative review flow: request, preparation, saved checkpoint"
		>
			<div className="flow-signal" aria-hidden="true" />
			<ol>
				{[
					{ icon: "code" as const, title: "Request", file: "review.ts", note: "Open the review" },
					{
						icon: "layers" as const,
						title: "Prepare",
						file: "prepare.ts",
						note: "Restore the context",
					},
					{
						icon: "check" as const,
						title: "Checkpoint",
						file: "review-store.ts",
						note: "Save the position",
					},
				].map((node, index) => (
					<li key={node.title}>
						<span className="flow-number">0{index + 1}</span>
						<span className="flow-node-icon">
							<Icon name={node.icon} size={20} />
						</span>
						<strong>{node.title}</strong>
						<code>{node.file}</code>
						<small>{node.note}</small>
					</li>
				))}
			</ol>
			<p>One connected explanation, from entry point to finish.</p>
		</div>
	);
}
export function FlowView() {
	const { state, dispatch } = useStory();
	return (
		<div className="flow-view">
			<fieldset className="mode-tabs" aria-label="Ways to understand the change">
				{(
					[
						["flow", "The entire flow"],
						["run", "Ask for a run"],
						["visual", "Explain visually"],
					] as const
				).map(([view, label]) => (
					<button
						type="button"
						key={view}
						aria-pressed={state.flow === view}
						onClick={() => dispatch({ type: "flow", view })}
					>
						{label}
					</button>
				))}
			</fieldset>
			{state.flow === "run" ? (
				<div className="run-example">
					<div className="terminal-heading">
						<span className="tiny-dot" />A run is its own piece of evidence
						<span className="example-tag">Example request</span>
					</div>
					<code>$ bun test review/session.test.ts</code>
					<p>“Can you run the configured check for this change?”</p>
					<div className="run-awaiting">
						<Icon name="clock" size={15} />
						Execution belongs in the app’s isolated workspace. Its real output comes back for
						inspection.
					</div>
					<span className="micro-label">This website does not execute the command.</span>
				</div>
			) : (
				<>
					<FlowGraphic />
					{state.flow === "visual" && (
						<div className="visual-explanation">
							<Icon name="spark" size={16} />
							<p>
								Think of the checkpoint as a bookmark. The route opens the book, preparation finds
								the right edition, and persistence remembers the page.
							</p>
						</div>
					)}
				</>
			)}
		</div>
	);
}

export function FixView() {
	const { state, dispatch } = useStory();
	const lines =
		state.proposal === "before"
			? [
					"await saveCheckpoint({",
					"  review: input.id,",
					"  file: input.file,",
					"  position: input.position,",
					"});",
				]
			: [
					"await saveCheckpoint({",
					"  review: input.id,",
					"  file: input.file,",
					"  head: input.head,",
					"  position: input.position,",
					"});",
				];
	return (
		<div className="fix-view">
			<SourceLabel source="github">A proposed change · For the author to review</SourceLabel>
			<div className="proposal-comment">
				<Icon name="chat" size={16} />
				<p>
					“Could we bind the checkpoint to the source revision, so it doesn’t silently reopen a
					different version?”
				</p>
			</div>
			<div className="proposal-box">
				<div className="file-bar">
					<span>src/db/review-store.ts</span>
					<fieldset className="inline-tabs" aria-label="Compare proposed change">
						<button
							type="button"
							aria-pressed={state.proposal === "before"}
							onClick={() => dispatch({ type: "proposal", view: "before" })}
						>
							Before
						</button>
						<button
							type="button"
							aria-pressed={state.proposal === "after"}
							onClick={() => dispatch({ type: "proposal", view: "after" })}
						>
							Proposed
						</button>
					</fieldset>
				</div>
				<Code lines={lines} added={state.proposal === "after"} />
			</div>
			<div className="proposal-footer">
				<span>
					<Icon name="code" size={14} />A concrete change to inspect.
				</span>
				<span>
					Author review comes next <Icon name="arrow" size={14} />
				</span>
			</div>
		</div>
	);
}

export function FollowView() {
	const { state, dispatch } = useStory();
	return (
		<div className="follow-view">
			<div className="policy-head">
				<Icon name="clock" size={18} />
				<div>
					<strong>Your review has a clear next step.</strong>
					<p>Leave an explicit policy for this teammate’s PR.</p>
				</div>
				<span className="example-tag">Illustration</span>
			</div>
			<div className="policy-conditions">
				<span className="micro-label">The conditions you leave</span>
				{[
					"Required checks must pass",
					"Review questions must be resolved",
					"New or changed scope comes back to me",
				].map((item) => (
					<p key={item}>
						<span className="policy-check">
							<Icon name="check" size={12} />
						</span>
						{item}
					</p>
				))}
			</div>
			<fieldset className="policy-choice" aria-label="Example follow-up instruction">
				<button
					type="button"
					aria-pressed={state.follow === "notify"}
					onClick={() => dispatch({ type: "follow", mode: "notify" })}
				>
					<Icon name="chat" size={15} />
					Notify me
				</button>
				<button
					type="button"
					aria-pressed={state.follow === "approve"}
					onClick={() => dispatch({ type: "follow", mode: "approve" })}
				>
					<Icon name="check" size={15} />
					Approve within my scope
				</button>
			</fieldset>
			<div className="policy-summary" aria-live="polite">
				<span className="tiny-dot" />
				<p>
					{state.follow === "approve"
						? "Only an explicitly authorized approval policy can approve a matching PR. It does not merge it. Changes outside that policy need you again."
						: "Keep following the PR. Bring it back when the conditions are met or the work needs another decision."}
				</p>
			</div>
			<span className="policy-footnote">
				Example policy only. In the app, you review its exact scope, duration and permissions.
			</span>
		</div>
	);
}

export function ClarifyView() {
	const { state, dispatch } = useStory();
	return (
		<div className="clarify-view">
			<SourceLabel source="slack">#product-help · Original thread</SourceLabel>
			<div className="thread-message">
				<span className="thread-avatar">A</span>
				<div>
					<strong>
						A teammate <small>Example request</small>
					</strong>
					<p>The website doesn’t load for me. Can you look into it?</p>
				</div>
			</div>
			{state.clarified ? (
				<>
					<div className="thread-message clarification-reply">
						<span className="thread-avatar brand-avatar">
							<Brand name={false} size={24} />
						</span>
						<div>
							<strong>
								You, with MuseFocus <small>With your permission</small>
							</strong>
							<p>
								What are you trying to do, which account is affected, and what do you see when it
								fails?
							</p>
						</div>
					</div>
					<div className="thread-message">
						<span className="thread-avatar">A</span>
						<div>
							<strong>A teammate</strong>
							<p>I open the billing page with a team account. It stays on the loading screen.</p>
						</div>
					</div>
					<div className="clarified-brief">
						<Icon name="spark" size={15} />
						<span>
							A better starting point: <strong>billing page · team account · loading state</strong>
						</span>
					</div>
				</>
			) : (
				<div className="clarification-placeholder">
					<Icon name="chat" size={22} />
					<p>
						The useful context is still missing.
						<br />
						You don’t have to be the messenger.
					</p>
				</div>
			)}
			<button
				className="conversation-trigger"
				type="button"
				aria-expanded={state.clarified}
				onClick={() => dispatch({ type: "clarify" })}
			>
				<Icon name="chat" size={14} />
				{state.clarified ? "Reset the thread example" : "See a clarification example"}
				<Icon name="arrow" size={14} />
			</button>
		</div>
	);
}
