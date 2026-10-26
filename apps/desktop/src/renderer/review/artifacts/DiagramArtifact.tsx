import { useId } from "react";
import type { CodeLocation, DiagramSpec } from "../../../shared/contracts";
import { diagramDrawio } from "./diagram-drawio";
import {
	type DiagramBox,
	diagramEvidenceLabel,
	diagramLocation,
	layoutDiagram,
} from "./diagram-model";
import "./diagram.css";

export type DiagramArtifactProps = {
	diagram: DiagramSpec;
	onSelect: (location: CodeLocation) => void;
};

function SourceBox({
	box,
	onSelect,
}: { box: DiagramBox; onSelect: DiagramArtifactProps["onSelect"] }) {
	const { node } = box;
	const { location } = node;
	const description = `${node.label}; ${location.repository}; ${diagramLocation(location)}; ${location.revision} at ${location.commitSha}`;
	return (
		<button
			type="button"
			className="diagram-source-box"
			style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
			onClick={() => onSelect(location)}
			aria-label={`Open source: ${description}`}
			title={description}
			data-node-id={node.id}
		>
			<strong>{box.labelLines.join("\n")}</strong>
			<code className="diagram-source-path">{box.sourceLines.join("\n")}</code>
			<span className="diagram-source-revision">
				{location.revision} · {location.commitSha.slice(0, 8)}
				<span aria-hidden="true"> ↗</span>
			</span>
		</button>
	);
}

function Provenance({ diagram }: { diagram: DiagramSpec }) {
	const { evidence } = diagram;
	return (
		<details className="diagram-evidence">
			<summary>Evidence details</summary>
			<dl>
				<dt>Diagram</dt>
				<dd>{diagram.id}</dd>
				<dt>PR</dt>
				<dd>{diagram.prId}</dd>
				{evidence.kind === "fixture" ? (
					<>
						<dt>Fixture</dt>
						<dd>{evidence.fixtureId}</dd>
						<dt>Context</dt>
						<dd>{evidence.label}</dd>
					</>
				) : evidence.kind === "source" ? (
					<>
						<dt>Source</dt>
						<dd>{evidence.url}</dd>
						<dt>Retrieved</dt>
						<dd>{evidence.retrievedAt}</dd>
					</>
				) : (
					<>
						<dt>Run</dt>
						<dd>{evidence.runId}</dd>
						<dt>Commit</dt>
						<dd>{evidence.commitSha}</dd>
						<dt>Command</dt>
						<dd>
							<code>{JSON.stringify(evidence.command)}</code>
						</dd>
						<dt>Started</dt>
						<dd>{evidence.startedAt}</dd>
						<dt>Completed</dt>
						<dd>{evidence.completedAt}</dd>
						<dt>Exit code</dt>
						<dd>{evidence.exitCode}</dd>
						<dt>Log</dt>
						<dd>{evidence.logUrl}</dd>
					</>
				)}
			</dl>
		</details>
	);
}

export function DiagramArtifact({ diagram, onSelect }: DiagramArtifactProps) {
	const id = useId();
	const graph = layoutDiagram(diagram);
	const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));
	const titleId = `${id}-title`;
	const arrowId = `${id}-arrow`;
	return (
		<section className="diagram-artifact" aria-labelledby={titleId}>
			<h3 id={titleId}>{diagram.title}</h3>
			<p className="diagram-origin" data-evidence-kind={diagram.evidence.kind}>
				{diagramEvidenceLabel(diagram.evidence)}
			</p>
			<p className="diagram-hint">Select a box to open its pinned source.</p>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll region must support keyboard panning. */}
			<section className="diagram-viewport" aria-label="Codebase diagram" tabIndex={0}>
				<div className="diagram-canvas" style={{ width: graph.width, height: graph.height }}>
					<svg
						width={graph.width}
						height={graph.height}
						aria-hidden="true"
						className="diagram-connectors"
					>
						<defs>
							<marker
								id={arrowId}
								viewBox="0 0 10 10"
								refX="8"
								refY="5"
								markerWidth="6"
								markerHeight="6"
								orient="auto-start-reverse"
							>
								<path d="M 0 0 L 10 5 L 0 10 z" />
							</marker>
						</defs>
						{graph.connectors.map(({ index, path, badge }) => (
							<g key={index} data-edge-index={index}>
								<path className="diagram-connector" d={path} markerEnd={`url(#${arrowId})`} />
								<circle cx={badge.x} cy={badge.y} r="10" />
								<text x={badge.x} y={badge.y} dy=".35em" textAnchor="middle">
									{index + 1}
								</text>
							</g>
						))}
					</svg>
					{graph.boxes.map((box) => (
						<SourceBox key={box.node.id} box={box} onSelect={onSelect} />
					))}
				</div>
			</section>
			<div className="diagram-relationships">
				<p>
					{diagram.nodes.length} source {diagram.nodes.length === 1 ? "box" : "boxes"} ·{" "}
					{diagram.edges.length} {diagram.edges.length === 1 ? "connection" : "connections"}
				</p>
				{diagram.edges.length ? (
					<ol aria-label="Diagram connections">
						{diagram.edges.map((edge, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: Edges have no contract ID; retain identical parallel entries.
							<li key={index}>
								<span>
									{nodes.get(edge.from)?.label} <span aria-label="to">→</span>{" "}
									{nodes.get(edge.to)?.label}
								</span>
								{edge.label !== undefined && <strong>{edge.label}</strong>}
							</li>
						))}
					</ol>
				) : (
					<p>No connections supplied.</p>
				)}
			</div>
			<Provenance diagram={diagram} />
			<a
				className="diagram-export"
				download="codebase-diagram.drawio"
				href={`data:application/xml;charset=utf-8,${encodeURIComponent(diagramDrawio(diagram))}`}
			>
				Download editable diagram
			</a>
		</section>
	);
}
