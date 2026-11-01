"use client";
import { AnimatedBrand } from "./brand";
import { Icon } from "./icons";
import { useStory } from "./story/context";

export function Hero() {
	const { state } = useStory();
	return (
		<section className="hero" aria-labelledby="hero-heading">
			<div className="hero-light" aria-hidden="true" />
			<div className="hero-mark">
				<AnimatedBrand paused={state.paused} focusToken={state.chapter} autoAdvance />
			</div>
			<p className="eyebrow">Your attention, well spent</p>
			<h1 id="hero-heading">
				Let work flow.
				<br />
				Keep your <span className="ice-text">focus.</span>
			</h1>
			<p className="hero-copy">
				AI moves ten things forward at once. MuseFocus connects the work, carries the context, and
				brings one thing at a time into focus.
			</p>
			<div className="hero-actions">
				<a className="button primary" href="#demo">
					Explore a day with MuseFocus <Icon name="arrow" />
				</a>
				<a className="text-link" href="#why">
					Why focus? <span aria-hidden="true">↘</span>
				</a>
			</div>
			<p className="availability">
				<span className="status-dot" /> Built for macOS <span aria-hidden="true">·</span> In
				development
			</p>
		</section>
	);
}
