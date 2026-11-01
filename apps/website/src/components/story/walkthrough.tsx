"use client";
import { captures } from "@/lib/captures";
import { chapters } from "@/lib/story";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Image from "next/image";
import { useRef } from "react";
import { AnimatedBrand } from "../brand";
import { Icon } from "../icons";
import { useStory } from "./context";

export function Walkthrough() {
	const { state, dispatch } = useStory();
	const index = chapters.findIndex((c) => c.id === state.chapter);
	const chapter = chapters[index] ?? chapters[0];
	const capture = captures[state.chapter];
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
					<AnimatedBrand size={64} paused={state.paused} focusToken={state.chapter} />
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
			<div id="story-panel" role="tabpanel" aria-labelledby={`chapter-${chapter.id}`}>
				<div className="capture-heading">
					<h3>{chapter.title}</h3>
					<p>{capture.caption}</p>
				</div>
				<AnimatePresence mode="wait" initial={false}>
					<motion.figure
						key={chapter.id}
						initial={reduce ? false : { opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0 }}
						transition={{ duration: reduce ? 0 : 0.2 }}
					>
						<a
							href={capture.src}
							target="_blank"
							rel="noreferrer"
							aria-label={`Open full-size capture: ${chapter.label}`}
						>
							<Image
								className="real-app-capture"
								src={capture.src}
								width={2880}
								height={1920}
								alt={capture.alt}
								priority={index === 0}
								sizes="(max-width: 760px) 100vw, 1160px"
							/>
						</a>
					</motion.figure>
				</AnimatePresence>
				<div className="capture-actions">
					<a className="text-link" href={capture.src} target="_blank" rel="noreferrer">
						Open full size ↗
					</a>
					<button
						className="button next-button"
						type="button"
						onClick={() => dispatch({ type: "next" })}
					>
						{index === chapters.length - 1 ? "Back to the start" : "Next into focus"}
						<Icon name="arrow" size={14} />
					</button>
				</div>
			</div>
			<p className="demo-caption">
				Illustrative walkthrough captured in MuseFocus with prepared demo data. Select a scene or
				open a capture at full size.
			</p>
			<output aria-live="polite" aria-atomic="true" className="sr-only">
				{chapter.label} in focus. {chapter.title}
			</output>
		</section>
	);
}
