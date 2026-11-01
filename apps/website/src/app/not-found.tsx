import Link from "next/link";
export default function NotFound() {
	return (
		<main className="not-found">
			<p className="eyebrow">A little out of focus</p>
			<h1>Let’s get you back.</h1>
			<p>This page isn’t here.</p>
			<Link href="/" className="button primary">
				Back to MuseFocus <span aria-hidden="true">→</span>
			</Link>
		</main>
	);
}
