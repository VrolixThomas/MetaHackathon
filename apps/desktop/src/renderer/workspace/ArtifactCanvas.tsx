import { useId } from "react";
import { type Canvas, type CodeLocation, VisualSpecSchema } from "../../shared/contracts";
import { MarkdownContent } from "./MarkdownContent";

type Artifact = Extract<Canvas, { kind: "document" | "visual" }>;

export function ArtifactCanvas({
	canvas,
	onReference,
}: {
	canvas: Artifact;
	onReference?(location: CodeLocation): void;
}) {
	const titleId = useId();
	const visual = canvas.kind === "visual" ? VisualSpecSchema.safeParse(canvas.visual) : null;
	return (
		<article
			className={`artifact-canvas artifact-${canvas.kind}`}
			data-artifact-revision={canvas.revision}
		>
			<header className="artifact-heading">
				<div>
					<span className="artifact-kind">
						{canvas.kind === "document" ? "Document" : "Visual mockup"} · agent draft
					</span>
					<h1>{canvas.title}</h1>
				</div>
			</header>
			{canvas.kind === "document" ? (
				<MarkdownContent markdown={canvas.markdown} />
			) : visual?.success ? (
				<div className="canvas-visual-stage">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox={`0 0 ${visual.data.width} ${visual.data.height}`}
						width={visual.data.width}
						height={visual.data.height}
						role="img"
						aria-labelledby={titleId}
					>
						<title id={titleId}>{canvas.title}</title>
						<rect
							width={visual.data.width}
							height={visual.data.height}
							fill={visual.data.background}
						/>
						{visual.data.elements.map((element, index) => {
							// Drawing order is the identity of stateless SVG primitives, including identical shapes.
							const key = `${element.kind}:${index}`;
							if (element.kind === "rect")
								return (
									<rect
										key={key}
										x={element.x}
										y={element.y}
										width={element.width}
										height={element.height}
										rx={element.radius}
										fill={element.fill}
										stroke={element.stroke}
									/>
								);
							if (element.kind === "line")
								return (
									<line
										key={key}
										x1={element.x}
										y1={element.y}
										x2={element.x2}
										y2={element.y2}
										stroke={element.stroke}
										strokeWidth={element.width ?? 1}
									/>
								);
							return (
								<text
									key={key}
									x={element.x}
									y={element.y}
									fill={element.fill}
									fontSize={element.fontSize}
									fontWeight={element.weight ?? "normal"}
									fontFamily="system-ui, sans-serif"
								>
									{element.text}
								</text>
							);
						})}
					</svg>
				</div>
			) : (
				<p role="alert">This visual specification cannot be displayed.</p>
			)}
			{canvas.references.length > 0 && (
				<details className="canvas-references">
					<summary>Source references · {canvas.references.length}</summary>
					<ul>
						{canvas.references.map((location) => (
							<li key={JSON.stringify(location)}>
								{onReference ? (
									<button type="button" className="quiet" onClick={() => onReference(location)}>
										{location.path}:{location.startLine}–{location.endLine}
									</button>
								) : (
									<span>
										{location.path}:{location.startLine}–{location.endLine}
									</span>
								)}
								<small>
									{location.revision} · {location.commitSha.slice(0, 8)}
								</small>
							</li>
						))}
					</ul>
				</details>
			)}
		</article>
	);
}
