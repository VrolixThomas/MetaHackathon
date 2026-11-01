"use client";
import { chapters } from "@/lib/story";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { AnimatedBrand, Brand } from "../brand";
import { Icon } from "../icons";
import { useStory } from "./context";
import { ClarifyView, FixView, FlowView, FollowView, PlanView, ReviewView } from "./views";

const views = {
	plan: PlanView,
	review: ReviewView,
	flow: FlowView,
	fix: FixView,
	follow: FollowView,
	clarify: ClarifyView,
};
export function Walkthrough() {
	const { state, dispatch } = useStory();
	const index = chapters.findIndex((c) => c.id === state.chapter);
	const chapter = chapters[index] ?? chapters[0];
	const View = views[state.chapter];
	const reduce = useReducedMotion() || state.paused;
	const tabs = useRef<(HTMLButtonElement | null)[]>([]);
	return (
		<section
			className={`demo-section ${state.paused ? "ambient-paused" : ""}`}
			id="demo"
			aria-labelledby="demo-heading"
		>
			<div className="demo-intro">
				<div className="demo-focus-heading">
					<AnimatedBrand
						size={64}
						paused={state.paused}
						focusToken={`${state.chapter}:${state.chapter === "review" ? state.file : state.chapter === "flow" ? state.flow : ""}`}
					/>
					<div>
						<span className="eyebrow">One connected day</span>
						<h2 id="demo-heading">Everything moves. Your focus stays clear.</h2>
					</div>
				</div>
				<button
					type="button"
					className="motion-toggle"
					aria-pressed={state.paused}
					onClick={() => dispatch({ type: "motion" })}
				>
					<Icon name={state.paused ? "play" : "pause"} size={11} />
					{state.paused ? "Resume motion" : "Pause motion"}
				</button>
			</div>
			<div className="chapter-tabs" role="tablist" aria-label="Explore a day with MuseFocus">
				{chapters.map((item, i) => (
					<button
						type="button"
						role="tab"
						key={item.id}
						id={`chapter-${item.id}`}
						aria-selected={state.chapter === item.id}
						aria-controls="story-panel"
						tabIndex={state.chapter === item.id ? 0 : -1}
						ref={(node) => {
							tabs.current[i] = node;
						}}
						onClick={() => dispatch({ type: "chapter", chapter: item.id })}
						onKeyDown={(event) => {
							if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
							event.preventDefault();
							const next =
								event.key === "Home"
									? 0
									: event.key === "End"
										? chapters.length - 1
										: (i + (event.key === "ArrowRight" ? 1 : -1) + chapters.length) %
											chapters.length;
							const target = chapters[next];
							if (target) {
								dispatch({ type: "chapter", chapter: target.id });
								tabs.current[next]?.focus();
							}
						}}
					>
						<span>0{i + 1}</span>
						{item.label}
					</button>
				))}
			</div>
			<div className="app-window">
				<div className="window-bar">
					<div className="traffic-lights" aria-hidden="true">
						<i />
						<i />
						<i />
					</div>
					<span>MuseFocus</span>
					<span className="example-label">Interactive illustration</span>
				</div>
				<div className="workspace">
					<aside className="work-sidebar" aria-label="Illustrative background work">
						<div className="sidebar-brand">
							<Brand size={26} />
						</div>
						<span className="sidebar-label">Your work, connected</span>
						<div className="work-source">
							<Icon name="linear" size={15} />
							<div>
								<strong>Session recovery</strong>
								<small>
									{state.planScope ? "First pass in motion" : "A question before we start"}
								</small>
							</div>
							<span className="tiny-dot" />
						</div>
						<div className="work-source">
							<Icon name="github" size={15} />
							<div>
								<strong>Review progress</strong>
								<small>Teammate’s PR · Ready for review</small>
							</div>
							<span className="tiny-dot quiet" />
						</div>
						<div className="work-source">
							<Icon name="slack" size={15} />
							<div>
								<strong>Website won’t load</strong>
								<small>{state.clarified ? "Context is clearer" : "Missing a little context"}</small>
							</div>
							<span className="tiny-dot quiet" />
						</div>
						<div className="sidebar-bottom">
							<span className="activity-bars" aria-hidden="true">
								<i />
								<i />
								<i />
								<i />
								<i />
							</span>
							<p>
								Work keeps moving.
								<br />
								<span>You set the pace.</span>
							</p>
						</div>
					</aside>
					<div
						className="focus-workspace"
						id="story-panel"
						role="tabpanel"
						aria-labelledby={`chapter-${chapter.id}`}
					>
						<div className="workspace-bar">
							<span>
								<i className="focus-pip" />
								In focus<span className="slash">/</span>
								{chapter.source}
							</span>
							<span className="mono">0{index + 1} / 06</span>
						</div>
						<div className="story-content">
							<AnimatePresence mode="wait" initial={false}>
								<motion.div
									key={chapter.id}
									initial={reduce ? false : { opacity: 0, y: 9 }}
									animate={{ opacity: 1, y: 0 }}
									exit={{ opacity: 0 }}
									transition={{ duration: reduce ? 0 : 0.18 }}
								>
									<p className="scene-eyebrow">{chapter.cue}</p>
									<h3>{chapter.title}</h3>
									<p className="scene-description">{chapter.subtitle}</p>
									<div className="scene-view">
										<View />
									</div>
								</motion.div>
							</AnimatePresence>
						</div>
						<div className="focus-actions">
							<span>
								<Icon name="spark" size={13} />
								Your attention stays here.
							</span>
							<button
								type="button"
								className="button next-button"
								onClick={() => dispatch({ type: "next" })}
							>
								{index === chapters.length - 1
									? "Back to the start"
									: state.chapter === "review"
										? "Show the entire flow"
										: "Next into focus"}
								<Icon name="arrow" size={14} />
							</button>
						</div>
					</div>
				</div>
			</div>
			<p className="demo-caption">
				Interactive product illustration. Tickets, code, conversations and policies are scripted
				examples.
			</p>
			<output aria-live="polite" aria-atomic="true" className="sr-only">
				{chapter.label} in focus. {chapter.title}
			</output>
		</section>
	);
}
