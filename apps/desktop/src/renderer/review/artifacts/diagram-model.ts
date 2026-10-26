import type { CodeLocation, DiagramSpec, Evidence } from "../../../shared/contracts";

export type DiagramNode = DiagramSpec["nodes"][number];
export type DiagramEdge = DiagramSpec["edges"][number];
export type DiagramBox = {
	node: DiagramNode;
	x: number;
	y: number;
	width: number;
	height: number;
	labelLines: string[];
	sourceLines: string[];
};
export type DiagramConnector = {
	edge: DiagramEdge;
	index: number;
	path: string;
	badge: { x: number; y: number };
};

/** Explicit wrapping keeps the complete label readable without scaling down the graph. */
export function diagramTextLines(text: string, limit: number): string[] {
	if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Line length must be positive");
	if (text.includes("\n")) return text.split("\n").flatMap((line) => diagramTextLines(line, limit));
	const characters = Array.from(text);
	const lines: string[] = [];
	while (characters.length > limit) {
		const candidate = characters.slice(0, limit);
		const boundary = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("/"));
		const count = boundary >= limit / 2 ? boundary + 1 : limit;
		lines.push(characters.splice(0, count).join(""));
	}
	lines.push(characters.join(""));
	return lines;
}

export function diagramLocation(location: CodeLocation): string {
	return `${location.path}:${location.startLine}${location.endLine === location.startLine ? "" : `-${location.endLine}`}`;
}

export function diagramEvidenceLabel(evidence: Evidence): string {
	switch (evidence.kind) {
		case "fixture":
			return "Illustrative fixture · not executed";
		case "source":
			return "Source evidence · not execution";
		case "execution":
			return `Execution evidence · exit ${evidence.exitCode}`;
	}
}

/**
 * The supplied order is a reading order, never an inferred relationship. Every edge
 * gets its own connector, including repeated edges, reverse edges and self-loops.
 * Side lanes scroll horizontally for dense graphs instead of shrinking source text.
 */
export function layoutDiagram(diagram: DiagramSpec) {
	const order = new Map(diagram.nodes.map((node, index) => [node.id, index]));
	const adjacent = diagram.edges.map((edge) => {
		const from = order.get(edge.from);
		const to = order.get(edge.to);
		return from !== undefined && to === from + 1;
	});
	// Only one edge can occupy the direct gap between two successive boxes.
	const directPairs = new Set<string>();
	let leftLanes = 0;
	let rightLanes = 0;
	const routes = diagram.edges.map((edge, index) => {
		const pair = JSON.stringify([edge.from, edge.to]);
		if (adjacent[index] && !directPairs.has(pair)) {
			directPairs.add(pair);
			return { side: "direct" as const, lane: 0 };
		}
		if (leftLanes <= rightLanes) return { side: "left" as const, lane: ++leftLanes };
		return { side: "right" as const, lane: ++rightLanes };
	});
	const boxWidth = 224;
	const laneWidth = 28;
	const x = 18 + leftLanes * laneWidth;
	let y = 14;
	const boxes: DiagramBox[] = diagram.nodes.map((node) => {
		const labelLines = diagramTextLines(node.label, 26);
		const sourceLines = diagramTextLines(diagramLocation(node.location), 32);
		const height = 54 + labelLines.length * 18 + sourceLines.length * 15;
		const box = { node, x, y, width: boxWidth, height, labelLines, sourceLines };
		y += height + 48;
		return box;
	});
	const byId = new Map(boxes.map((box) => [box.node.id, box]));
	const connectors: DiagramConnector[] = diagram.edges.map((edge, index) => {
		const from = byId.get(edge.from);
		const to = byId.get(edge.to);
		const route = routes[index];
		// The shared boundary parser rejects dangling edges; never silently drop one here.
		if (!from || !to || !route) throw new Error("Diagram edge references an unknown node");
		if (route.side === "direct") {
			const center = x + boxWidth / 2;
			const bottom = from.y + from.height;
			return {
				edge,
				index,
				path: `M ${center} ${bottom} L ${center} ${to.y - 3}`,
				badge: { x: center, y: (bottom + to.y) / 2 },
			};
		}
		const left = route.side === "left";
		const anchorX = left ? x : x + boxWidth;
		const laneX = anchorX + (left ? -1 : 1) * route.lane * laneWidth;
		const startY = from.y + from.height / 2 + 12;
		const endY = to.y + to.height / 2 - 12;
		const endX = anchorX + (left ? -3 : 3);
		return {
			edge,
			index,
			path: `M ${anchorX} ${startY} H ${laneX} V ${endY} H ${endX}`,
			badge: { x: laneX, y: (startY + endY) / 2 },
		};
	});
	return {
		boxes,
		connectors,
		width: x + boxWidth + rightLanes * laneWidth + 18,
		height: Math.max(28, y - 48 + 14),
	};
}
