"use client";
import type { ReleaseState } from "@/lib/releases";
import { AnimatedBrand } from "./brand";
import { DownloadButton } from "./download";
import { useStory } from "./story/context";

export function Hero({ release }: { release: ReleaseState }) {
	const { state } = useStory();
	const downloadable = release.status === "ready" && release.downloads.length > 0;
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
				<DownloadButton release={release} />
				<a className="text-link" href="#demo">
					See it in action <span aria-hidden="true">↘</span>
				</a>
			</div>
			<p className="availability">
				<span className="status-dot" /> Built for macOS <span aria-hidden="true">·</span>{" "}
				{downloadable ? release.version : "Follow development on GitHub"}
			</p>
		</section>
	);
}
