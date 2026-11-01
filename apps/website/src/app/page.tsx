import { Brand } from "@/components/brand";
import { Hero } from "@/components/hero";
import { Nav } from "@/components/nav";
import { StoryProvider } from "@/components/story/context";
import { Walkthrough } from "@/components/story/walkthrough";
import { Closing, Sources, WhyFocus, WorkflowSections } from "@/components/workflow-sections";
import { questions } from "@/lib/story";

export default function HomePage() {
	return (
		<StoryProvider>
			<a href="#main" className="skip-link">
				Skip to content
			</a>
			<div id="top" />
			<Nav />
			<main id="main" className="relative z-10">
				<Hero />
				<Walkthrough />
				<WhyFocus />
				<WorkflowSections />
				<Sources />
				<section
					id="questions"
					className="questions content-width"
					aria-labelledby="questions-heading"
				>
					<div>
						<p className="eyebrow">A few things, in focus</p>
						<h2 id="questions-heading">Good questions.</h2>
					</div>
					<div className="faq-list">
						{questions.map((item) => (
							<details key={item.question}>
								<summary>
									{item.question}
									<span aria-hidden="true">+</span>
								</summary>
								<p>{item.answer}</p>
							</details>
						))}
					</div>
				</section>
				<Closing />
			</main>
			<footer className="footer content-width">
				<a href="#top" aria-label="MuseFocus home">
					<Brand size={28} />
				</a>
				<p>Work moves. You focus.</p>
				<div>
					<a href="#workflow">The workflow</a>
					<a href="#questions">Questions</a>
					<a href="#top">Back to top ↑</a>
				</div>
			</footer>
		</StoryProvider>
	);
}
