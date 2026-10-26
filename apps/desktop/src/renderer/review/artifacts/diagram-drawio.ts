import type { DiagramSpec } from "../../../shared/contracts";
import { diagramEvidenceLabel, diagramLocation, layoutDiagram } from "./diagram-model";

function xml(value: string): string {
	return value.replace(/[&<>"'\n\r\t]/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&apos;",
			"\n": "&#10;",
			"\r": "&#13;",
			"\t": "&#9;",
		};
		return entities[character] ?? character;
	});
}

/** Native editable XML, entirely local. Metadata retains complete pinned provenance. */
export function diagramDrawio(diagram: DiagramSpec): string {
	const { boxes } = layoutDiagram(diagram);
	const evidenceLabel = diagramEvidenceLabel(diagram.evidence);
	const ids = new Map(boxes.map((box, index) => [box.node.id, `node-${index}`]));
	const nodes = boxes.map(({ node, x, y, width, height }, index) => {
		const label = `${node.label}\n${diagramLocation(node.location)}\n${node.location.revision} @ ${node.location.commitSha}`;
		return `<object id="node-${index}" label="${xml(label)}" nodeId="${xml(node.id)}" codeLocation="${xml(JSON.stringify(node.location))}"><mxCell vertex="1" parent="1" style="rounded=1;whiteSpace=wrap;html=0;fillColor=#1e232d;strokeColor=#61769b;fontColor=#e5e8ee;"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/></mxCell></object>`;
	});
	const edges = diagram.edges.map(
		(edge, index) =>
			`<mxCell id="edge-${index}" value="${xml(edge.label ?? "")}" source="${ids.get(edge.from)}" target="${ids.get(edge.to)}" edge="1" parent="1" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=0;endArrow=block;strokeColor=#96b0ff;fontColor=#e5e8ee;labelBackgroundColor=#17191e;"><mxGeometry relative="1" as="geometry"/></mxCell>`
	);
	return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="MetaHackathon"><diagram id="${xml(diagram.id)}" name="${xml(`${diagram.title} · ${evidenceLabel}`)}"><mxGraphModel adaptiveColors="none" background="#17191e" prId="${xml(diagram.prId)}" evidence="${xml(JSON.stringify(diagram.evidence))}" evidenceLabel="${xml(evidenceLabel)}"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${nodes.join("")}${edges.join("")}</root></mxGraphModel></diagram></mxfile>`;
}
