import { useEffect, useRef } from "react";
import { Icon } from "./Icons";
import { useReview } from "./controller";
import {
	cancelActiveQuestion,
	reviewSessionId,
	runAgentQuestion,
	useConversation,
} from "./conversation";
import { useServices } from "./services";

const suggestions = [
	"Walk me through this PR",
	"Show me the checkout",
	"Apply the promo code",
	"Show it on a phone",
	"Scroll to the payment button",
	"Show me the responsible code",
	"Compare it with before this PR",
];

/** Conversation remains beside every main surface; artifacts occupy the main workspace. */
export function AgentPanel() {
	const conversation = useConversation();
	const sourceMode = useReview((s) => s.sourceMode);
	const agent = useServices((s) => s.agent);
	const scroll = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = scroll.current;
		if (
			element &&
			(conversation.answer || conversation.question || conversation.state === "working")
		)
			element.scrollTop = element.scrollHeight;
	}, [conversation.answer, conversation.question, conversation.state]);
	return (
		<aside
			className="agent-panel conversation-panel"
			aria-label="Review conversation"
			data-conversation-state={conversation.state}
			data-session-id={reviewSessionId}
			data-turn-id={conversation.identity?.turnId}
			data-generation={conversation.identity?.generation}
			data-request-id={conversation.identity?.requestId}
		>
			<header className="panel-header">
				<span className="dot blue" />
				<strong>Review companion</strong>
				<span>{conversation.state === "working" ? "Thinking…" : "Ask or hold to talk"}</span>
			</header>
			<div className="panel-scroll" ref={scroll}>
				{!conversation.question && (
					<>
						<div className="exchange-label">Start with a question</div>
						<p className="agent-answer">Let’s walk through the change.</p>
						<p className="artifact-note">
							Ask about the PR, try the checkout together, and follow the result back to its code.
						</p>
						{sourceMode === "reference" && (
							<span className="evidence-label">
								Reference fixture · load the local demo to begin
							</span>
						)}
					</>
				)}
				{conversation.history.map((exchange, index) => (
					<div className="conversation-exchange" key={`${index}-${exchange.question}`}>
						<div className="exchange-label">You</div>
						<p className="user-words">{exchange.question}</p>
						<p className="conversation-answer">
							{exchange.answer || (exchange.state === "cancelled" ? "Stopped" : "No response")}
						</p>
					</div>
				))}
				{conversation.question && (
					<div className="conversation-exchange">
						<div className="exchange-label">You</div>
						<p className="user-words">{conversation.question}</p>
						<p className="conversation-answer" aria-live="polite">
							{conversation.answer ||
								(conversation.state === "working"
									? "Looking into it…"
									: conversation.state === "cancelled"
										? "Stopped"
										: "")}
						</p>
					</div>
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
				{!conversation.question && (
					<div className="suggestions">
						{suggestions.map((text) => (
							<button
								type="button"
								key={text}
								disabled={!agent || sourceMode === "reference"}
								onClick={() => void runAgentQuestion(text)}
							>
								{text}
								<Icon name="arrow" size={14} />
							</button>
						))}
					</div>
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
					aria-label="Ask about this review"
					placeholder="Ask about this review…"
					disabled={!agent || sourceMode === "reference"}
				/>
				<button
					type="submit"
					aria-label="Send question"
					disabled={!agent || sourceMode === "reference"}
				>
					<Icon name="arrow" size={16} />
				</button>
			</form>
		</aside>
	);
}
