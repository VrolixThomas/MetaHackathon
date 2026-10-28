import { useEffect, useState } from "react";
import type { CodeFlow, CodeLocation, PinnedSource } from "../../shared/contracts";
import { SyntaxText } from "../prepared/ReviewWorkspace";
import { type HighlightedSource, highlightSource } from "../prepared/highlighting";

/** Retain every source byte, including CRLF and the final newline, as escaped text. */
export function exactSourceRows(text: string) {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function SourceBlock({
	source,
	onReference,
}: {
	source: PinnedSource;
	onReference(location: CodeLocation): void;
}) {
	const { location, text } = source;
	const [syntax, setSyntax] = useState<{ source: PinnedSource; result: HighlightedSource } | null>(
		null
	);
	useEffect(() => {
		let current = true;
		void highlightSource({
			path: location.path,
			commitSha: location.commitSha,
			status: "available",
			content: text,
		}).then((result) => {
			if (current) setSyntax({ source, result });
		});
		return () => {
			current = false;
		};
	}, [source, location.path, location.commitSha, text]);
	const rows = exactSourceRows(text);
	return (
		<div
			className="hub-source"
			data-source-sha={location.commitSha}
			data-source-path={location.path}
		>
			<header className="hub-source-heading">
				<button type="button" className="quiet" onClick={() => onReference(location)}>
					{location.path}:{location.startLine}–{location.endLine}
				</button>
				<span title={location.commitSha}>
					{location.revision} · {location.commitSha.slice(0, 10)}
				</span>
			</header>
			<pre aria-label={`Source: ${location.path}`}>
				<code>
					{rows.map((raw, index) => {
						const line = location.startLine + index;
						const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
						return (
							<span className="hub-source-row" key={line} data-source-line={line}>
								<button
									type="button"
									className="hub-line-number"
									aria-label={`Open ${location.path} line ${line}`}
									onClick={() => onReference({ ...location, startLine: line, endLine: line })}
								>
									{line}
								</button>
								<span className="hub-source-text">
									<SyntaxText
										text={body}
										tokens={syntax?.source === source ? syntax.result.lines[index] : undefined}
									/>
									{raw.endsWith("\n") ? "\n" : ""}
								</span>
							</span>
						);
					})}
				</code>
			</pre>
			{!text && <p className="hub-muted">This pinned source range is empty.</p>}
			{source.truncated && (
				<p className="hub-muted">Bounded excerpt. Open a line to inspect its pinned source.</p>
			)}
		</div>
	);
}

export function SourceCanvas({
	source,
	onReference,
}: { source: PinnedSource; onReference(location: CodeLocation): void }) {
	return (
		<article className="hub-source-canvas">
			<div className="hub-artifact-title">
				<span className="eyebrow">Pinned source · {source.location.repository}</span>
				<h1>{source.location.path}</h1>
			</div>
			<SourceBlock source={source} onReference={onReference} />
		</article>
	);
}

export function FlowCanvas({
	flow,
	onReference,
}: { flow: CodeFlow; onReference(location: CodeLocation): void }) {
	return (
		<article className="hub-flow-canvas">
			<header className="hub-artifact-title">
				<span className="eyebrow">Source flow · inferred reading order</span>
				<h1>{flow.title}</h1>
				<p>{flow.summary}</p>
			</header>
			<ol className="hub-flow-steps">
				{flow.steps.map((step, index) => (
					<li key={step.id}>
						<div className="hub-flow-explanation">
							<span className="hub-flow-index">{index + 1}</span>
							<div>
								<h2>{step.title}</h2>
								<p>{step.explanation}</p>
							</div>
						</div>
						<SourceBlock source={step.source} onReference={onReference} />
					</li>
				))}
			</ol>
		</article>
	);
}
