import Image from "next/image";
import { Brand } from "./brand";
import { Icon } from "./icons";
import { StoryLink } from "./story/context";
import { FlowGraphic } from "./story/views";

export function WhyFocus() {
	return (
		<section id="why" className="thesis content-width" aria-labelledby="why-heading">
			<p className="eyebrow">A calmer way to move forward</p>
			<h2 id="why-heading">
				More work in flight.
				<br />
				<span>Less room in your head.</span>
			</h2>
			<p>
				Tickets in one tab. PRs in another. A Slack message that becomes another task. AI speeds up
				the work, while remembering, reviewing and following up still falls to you.
			</p>
			<div className="focus-principle">
				<span>Work from everywhere.</span>
				<span className="principle-line" aria-hidden="true" />
				<Brand name={false} size={36} />
				<span className="principle-line" aria-hidden="true" />
				<strong>One point of focus.</strong>
			</div>
		</section>
	);
}

export function WorkflowSections() {
	return (
		<div id="workflow">
			<section className="feature content-width" aria-labelledby="plan-heading">
				<div className="feature-copy">
					<span className="step-label">01 / Turn intent into a first pass</span>
					<h2 id="plan-heading">
						Plan with a partner.
						<br />
						Build a thoughtful v1.
					</h2>
					<p>
						Start with the tickets you need to move forward. MuseFocus asks the questions that
						matter before a first implementation, then keeps independent work moving while you focus
						elsewhere.
					</p>
					<StoryLink chapter="plan">
						Shape the first pass <Icon name="arrow" size={15} />
					</StoryLink>
				</div>
				<div className="feature-visual planning-visual">
					<div className="mini-topbar">
						<Icon name="linear" size={14} />
						<span>Session recovery</span>
						<span className="example-tag">Example</span>
					</div>
					<p className="visual-question">
						“What should come back
						<br />
						when I reopen a workspace?”
					</p>
					<div className="mini-answer">
						<Brand name={false} size={28} />
						<p>Let’s decide what the first pass should remember.</p>
					</div>
					<div className="mini-choices">
						<span>
							<i />
							Files and review position
						</span>
						<span>
							<i />
							The working layout, too
						</span>
					</div>
					<div className="mini-bottom">
						<Icon name="spark" size={13} />A better brief starts with your judgment.
					</div>
				</div>
			</section>
			<section className="feature feature-reverse content-width" aria-labelledby="review-heading">
				<div className="feature-visual review-preview">
					<div className="mini-topbar">
						<Icon name="github" size={14} />
						<span>A reading order that tells the story</span>
						<span className="example-tag">Example</span>
					</div>
					<ol>
						{[
							{ n: "01", label: "Enter through the route", file: "src/routes/review.ts" },
							{ n: "02", label: "Follow the preparation", file: "src/review/prepare.ts" },
							{ n: "03", label: "Finish at persistence", file: "src/db/review-store.ts" },
						].map((file) => (
							<li key={file.n}>
								<span>{file.n}</span>
								<div>
									<strong>{file.label}</strong>
									<code>{file.file}</code>
								</div>
								<Icon name="arrow" size={13} />
							</li>
						))}
					</ol>
					<div className="mini-bottom">
						<Icon name="flow" size={14} />
						Entry point to finish. Context stays close.
					</div>
				</div>
				<div className="feature-copy">
					<span className="step-label">02 / Understand what you’re reviewing</span>
					<h2 id="review-heading">
						Follow the code.
						<br />
						See the bigger picture.
					</h2>
					<p>
						Review in a logical reading order, from the entry point through the change. Ask how it
						fits the ticket. Zoom out to the entire flow, request a run, or explore a visual
						explanation.
					</p>
					<p className="feature-aside">
						Have a concrete improvement? Prepare a proposed fix for the author to inspect.
					</p>
					<div className="feature-links">
						<StoryLink chapter="review">
							Explore a review <Icon name="arrow" size={15} />
						</StoryLink>
						<StoryLink chapter="flow">
							Show the entire flow <Icon name="flow" size={14} />
						</StoryLink>
					</div>
				</div>
			</section>
			<section
				className="flow-interlude content-width"
				aria-label="Move naturally between levels of detail"
			>
				<div>
					<span className="step-label">Zoom out without losing your place</span>
					<p>“Show me the entire flow.”</p>
				</div>
				<FlowGraphic compact />
			</section>
			<section className="feature content-width" aria-labelledby="follow-heading">
				<div className="feature-copy">
					<span className="step-label">03 / Make follow-up part of the work</span>
					<h2 id="follow-heading">
						Leave instructions.
						<br />
						Keep your focus.
					</h2>
					<p>
						Done reviewing? Leave explicit conditions for following the PR. MuseFocus can notify you
						when you’re needed again, or approve within the exact scope you authorize.
					</p>
					<p className="feature-aside">
						Your own work has a place to come back to, too. Ready work, review and approval remain
						distinct.
					</p>
					<StoryLink chapter="follow">
						Explore a follow-up <Icon name="arrow" size={15} />
					</StoryLink>
				</div>
				<div className="feature-visual follow-preview">
					<div className="mini-topbar">
						<Icon name="clock" size={14} />
						<span>After your review</span>
						<span className="example-tag">Example</span>
					</div>
					<p className="visual-question">
						“Bring it back when
						<br />
						the work needs me.”
					</p>
					<ul>
						<li>
							<Icon name="check" size={14} />
							Required checks pass
						</li>
						<li>
							<Icon name="check" size={14} />
							Review questions are resolved
						</li>
						<li>
							<Icon name="check" size={14} />
							New scope returns to you
						</li>
					</ul>
					<div className="mini-bottom">
						<span className="tiny-dot" />
						Following within your instructions.
					</div>
				</div>
			</section>
			<section className="feature feature-reverse content-width" aria-labelledby="clarify-heading">
				<div className="feature-visual slack-preview">
					<div className="mini-topbar">
						<Icon name="slack" size={14} />
						<span>In the original thread</span>
						<span className="example-tag">Example</span>
					</div>
					<div className="mini-thread">
						<span className="thread-avatar">A</span>
						<p>
							The website doesn’t load for me.
							<br />
							Can you look into it?
						</p>
					</div>
					<div className="mini-thread reply">
						<Brand name={false} size={27} />
						<div>
							<strong>You, with MuseFocus</strong>
							<p>What are you trying to do, which account is affected, and what happens?</p>
						</div>
					</div>
					<div className="mini-bottom">
						<Icon name="chat" size={13} />
						Bounded clarification, with your permission.
					</div>
				</div>
				<div className="feature-copy">
					<span className="step-label">04 / Stop being the messenger</span>
					<h2 id="clarify-heading">
						A vague request.
						<br />A clearer starting point.
					</h2>
					<p>
						“Can you look into it?” is rarely enough context. Authorize MuseFocus to ask bounded
						follow-up questions in the original Slack thread, in your name, while you stay with the
						work in front of you.
					</p>
					<StoryLink chapter="clarify">
						See the conversation <Icon name="arrow" size={15} />
					</StoryLink>
				</div>
			</section>
		</div>
	);
}

export function Sources() {
	return (
		<section className="context-section content-width" aria-labelledby="context-heading">
			<div>
				<span className="step-label">One ongoing conversation</span>
				<h2 id="context-heading">A partner throughout your day.</h2>
				<p>
					GitHub reviews. Linear tickets. The Slack conversations behind the work. MuseFocus brings
					them into the same conversation, with the right thing in focus.
				</p>
			</div>
			<div className="context-sources" aria-label="Work sources">
				<span>
					<Icon name="github" size={23} />
					GitHub
				</span>
				<span>
					<Icon name="linear" size={23} />
					Linear
				</span>
				<span>
					<Icon name="slack" size={23} />
					Slack
				</span>
			</div>
		</section>
	);
}

export function Closing() {
	return (
		<section className="closing" aria-labelledby="closing-heading">
			<div className="closing-light" aria-hidden="true" />
			<Image
				className="closing-mark"
				src="/brand/pull-forward.png"
				width={112}
				height={112}
				alt=""
			/>
			<h2 id="closing-heading">
				Your attention
				<br />
				is the point.
			</h2>
			<p>Give it to the work that needs you.</p>
			<a className="button primary" href="#demo">
				Find your focus <Icon name="arrow" />
			</a>
			<span className="closing-note">MuseFocus for macOS · In development</span>
		</section>
	);
}
