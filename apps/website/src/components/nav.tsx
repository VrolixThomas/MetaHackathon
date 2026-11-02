"use client";
import { REPOSITORY_URL } from "@/lib/releases";
import { useEffect, useState } from "react";
import { Brand } from "./brand";
import { Icon } from "./icons";

export function Nav() {
	const [scrolled, setScrolled] = useState(false);
	useEffect(() => {
		const update = () => setScrolled(window.scrollY > 10);
		update();
		window.addEventListener("scroll", update, { passive: true });
		return () => window.removeEventListener("scroll", update);
	}, []);
	return (
		<header className={`nav ${scrolled ? "scrolled" : ""}`}>
			<div className="nav-inner">
				<a href="#top" aria-label="MuseFocus home">
					<Brand />
				</a>
				<nav aria-label="Main navigation">
					<a href="#workflow">Your day, in focus</a>
					<a href={REPOSITORY_URL} className="nav-github" aria-label="MuseFocus on GitHub">
						<Icon name="github" size={19} /> <span>GitHub</span>
					</a>
					<a href="#download" className="nav-cta">
						Download <Icon name="download" size={16} />
					</a>
				</nav>
			</div>
		</header>
	);
}
