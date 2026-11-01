"use client";
import { useEffect, useState } from "react";
import { Brand } from "./brand";

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
					<a href="#questions">Questions</a>
					<a href="#demo" className="nav-cta">
						Find your focus <span aria-hidden="true">↗</span>
					</a>
				</nav>
			</div>
		</header>
	);
}
