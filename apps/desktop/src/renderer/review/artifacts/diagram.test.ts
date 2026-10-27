import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type DiagramSpec, DiagramSpecSchema } from "../../../shared/contracts";
import { getReviewFixture } from "../../../shared/fixtures/review";
import { DiagramArtifact } from "./DiagramArtifact";
import { diagramDrawio } from "./diagram-drawio";
import {
	diagramEvidenceLabel,
	diagramLocation,
	diagramTextLines,
	layoutDiagram,
} from "./diagram-model";

function graphFixture(): DiagramSpec {
	const fixture = getReviewFixture().diagram;
	const location = fixture.nodes[0]?.location;
	assert.ok(location);
	return DiagramSpecSchema.parse({
		...fixture,
		nodes: ["entry", "left", "right", "join", "isolated"].map((id, index) => ({
			id,
			label: id,
			location: {
				...location,
				repository: index === 2 ? "other/repo" : location.repository,
				revision: index % 2 ? "base" : "head",
				commitSha: index % 2 ? "a".repeat(40) : "b".repeat(40),
				path: `${id}/source.ts`,
				startLine: 21 + index,
				endLine: 29 + index,
			},
		})),
		edges: [
			{ from: "entry", to: "left", label: "one branch" },
			{ from: "entry", to: "right", label: "other branch" },
			{ from: "left", to: "join" },
			{ from: "right", to: "join", label: "converges" },
			{ from: "join", to: "entry", label: "retry" },
			{ from: "join", to: "join", label: "self-loop" },
			{ from: "entry", to: "left", label: "one branch" },
			{ from: "left", to: "entry", label: "reverse" },
		],
	});
}

function render(diagram: DiagramSpec) {
	return renderToStaticMarkup(
		createElement(DiagramArtifact, {
			diagram,
			onSelect: () => {
				throw new Error("Rendering must never select source");
			},
		})
	);
}

describe("codebase diagram", () => {
	it("retains all branching, converging, cyclic, self-loop and parallel edges", () => {
		const diagram = graphFixture();
		const before = structuredClone(diagram);
		const graph = layoutDiagram(diagram);
		assert.equal(graph.boxes.length, diagram.nodes.length);
		assert.equal(graph.connectors.length, diagram.edges.length);
		assert.equal(
			new Set(graph.connectors.map((connector) => connector.path)).size,
			diagram.edges.length
		);
		for (const [index, connector] of graph.connectors.entries()) {
			assert.equal(connector.edge, diagram.edges[index]);
			assert.match(connector.path, /^M /);
			assert.ok(connector.badge.x > 0 && connector.badge.x < graph.width);
			assert.ok(connector.badge.y > 0 && connector.badge.y < graph.height);
		}
		assert.deepEqual(diagram, before);
		assert.deepEqual(layoutDiagram(diagram), graph);
		const html = render(diagram);
		assert.equal((html.match(/data-edge-index=/g) ?? []).length, diagram.edges.length);
		assert.equal((html.match(/<li>/g) ?? []).length, diagram.edges.length);
		assert.equal((html.match(/data-node-id=/g) ?? []).length, diagram.nodes.length);
		assert.match(html, /self-loop/);
		assert.match(html, /reverse/);
	});

	it("preserves original object identity and all six pinned source fields for every box", () => {
		const diagram = graphFixture();
		const graph = layoutDiagram(diagram);
		for (const [index, box] of graph.boxes.entries()) {
			const original = diagram.nodes[index];
			assert.ok(original);
			assert.equal(box.node, original);
			assert.equal(box.node.location, original.location);
			assert.deepEqual(Object.keys(box.node.location).sort(), [
				"commitSha",
				"endLine",
				"path",
				"repository",
				"revision",
				"startLine",
			]);
		}
		assert.match(render(diagram), /other\/repo; right\/source.ts:23-31; head at b{40}/);
	});

	it("uses keyboard accessible native source buttons and unique SVG marker IDs per instance", () => {
		const diagram = getReviewFixture().diagram;
		const html = renderToStaticMarkup(
			createElement(
				"div",
				null,
				createElement(DiagramArtifact, { diagram, onSelect: () => {} }),
				createElement(DiagramArtifact, { diagram, onSelect: () => {} })
			)
		);
		assert.equal((html.match(/<button type="button"/g) ?? []).length, diagram.nodes.length * 2);
		assert.equal((html.match(/aria-label="Open source:/g) ?? []).length, diagram.nodes.length * 2);
		assert.doesNotMatch(html, /tabindex="-1"/);
		const markers = Array.from(html.matchAll(/<marker id="([^"]+)"/g), (match) => match[1]);
		assert.equal(new Set(markers).size, 2);
		for (const marker of markers) assert.ok(html.includes(`marker-end="url(#${marker})"`));
	});

	it("does not create relationships for disconnected or lone nodes", () => {
		const diagram = graphFixture();
		diagram.edges = [];
		assert.equal(layoutDiagram(diagram).connectors.length, 0);
		assert.equal(layoutDiagram(diagram).boxes.length, 5);
		assert.match(render(diagram), /No connections supplied/);
		diagram.nodes = diagram.nodes.slice(0, 1);
		assert.equal(layoutDiagram(diagram).boxes.length, 1);
		assert.match(render(diagram), /1 source box/);
	});

	it("keeps small graphs within a 360px panel with 19px side padding", () => {
		const graph = layoutDiagram(getReviewFixture().diagram);
		assert.ok(graph.width <= 360 - 38);
		for (const box of graph.boxes) {
			assert.ok(box.width >= 220);
			assert.ok(box.y + box.height < graph.height);
		}
	});

	it("wraps complete long labels and paths without loss, including non-ASCII text", () => {
		for (const text of ["WW".repeat(60), "Résumé 🧭 日本語 / ".repeat(12)]) {
			const lines = diagramTextLines(text, 26);
			assert.equal(lines.join(""), text);
			assert.ok(lines.every((line) => Array.from(line).length <= 26));
		}
		assert.deepEqual(diagramTextLines("first\nsecond", 26), ["first", "second"]);
		const diagram = getReviewFixture().diagram;
		const node = diagram.nodes[0];
		assert.ok(node);
		node.label = "Long readable label ".repeat(12);
		node.location.path = `${"nested/".repeat(20)}source.ts`;
		const graph = layoutDiagram(diagram);
		const first = graph.boxes[0];
		const second = graph.boxes[1];
		assert.ok(first && second);
		assert.equal(first.labelLines.join(""), node.label);
		assert.equal(first.sourceLines.join(""), diagramLocation(node.location));
		assert.ok(first.y + first.height < second.y);
	});

	it("makes fixture, source and execution provenance distinct and keeps all evidence details", () => {
		const diagram = getReviewFixture().diagram;
		assert.match(render(diagram), /Illustrative fixture · not executed/);
		assert.doesNotMatch(render(diagram), /Execution evidence/);
		diagram.evidence = {
			kind: "source",
			url: "https://example.com/source",
			retrievedAt: "2026-10-26T12:00:00Z",
		};
		assert.match(render(diagram), /Source evidence · not execution/);
		assert.match(render(diagram), /https:\/\/example.com\/source/);
		assert.match(render(diagram), /2026-10-26T12:00:00Z/);
		diagram.evidence = {
			kind: "execution",
			runId: "failed-run",
			commitSha: "c".repeat(40),
			command: ["bun", "test", "path with space"],
			startedAt: "2026-10-26T12:00:00Z",
			completedAt: "2026-10-26T12:00:01Z",
			exitCode: 1,
			logUrl: "https://example.com/log",
		};
		const html = render(diagram);
		assert.match(html, /Execution evidence · exit 1/);
		for (const value of [
			"failed-run",
			"c".repeat(40),
			"path with space",
			"https://example.com/log",
			"2026-10-26T12:00:01Z",
		])
			assert.ok(html.includes(value));
		assert.doesNotMatch(html, /verified|passed|successful/i);
		assert.equal(diagramEvidenceLabel(diagram.evidence), "Execution evidence · exit 1");
	});

	it("refuses malformed dangling edges rather than silently losing them", () => {
		const diagram = getReviewFixture().diagram;
		diagram.edges.push({ from: "unknown", to: "discount" });
		assert.equal(DiagramSpecSchema.safeParse(diagram).success, false);
		assert.throws(() => layoutDiagram(diagram), /unknown node/);
	});

	it("exports editable native cells for every node and edge with safe XML IDs and pinned metadata", () => {
		const diagram = graphFixture();
		const first = diagram.nodes[0];
		assert.ok(first);
		first.label = '<b>"quote" & rule</b>';
		diagram.title = 'Graph & "source"';
		const xml = diagramDrawio(diagram);
		assert.equal((xml.match(/vertex="1"/g) ?? []).length, diagram.nodes.length);
		assert.equal((xml.match(/edge="1"/g) ?? []).length, diagram.edges.length);
		assert.match(xml, /&lt;b&gt;&quot;quote&quot; &amp; rule&lt;\/b&gt;/);
		assert.match(xml, /adaptiveColors="none"/);
		assert.match(xml, /codeLocation="/);
		assert.match(xml, /Illustrative fixture · not executed/);
		assert.match(xml, /&quot;repository&quot;:&quot;other\/repo&quot;/);
		assert.match(xml, /&quot;commitSha&quot;:&quot;a{40}&quot;/);
		assert.match(xml, /<mxGeometry relative="1" as="geometry"\/>/);
		assert.doesNotMatch(xml, /<!--|<b>|undefined/);
		const ids = Array.from(xml.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
		assert.equal(new Set(ids).size, ids.length);
	});

	it("escapes labels in the renderer and exports locally without contacting an editor", () => {
		const diagram = getReviewFixture().diagram;
		diagram.title = "<script>alert('no')</script>";
		const html = render(diagram);
		assert.doesNotMatch(html, /<script>|https:\/\/app.diagrams.net/);
		assert.match(html, /download="codebase-diagram.drawio"/);
		const href = html.match(/href="data:application\/xml;charset=utf-8,([^"]+)"/);
		assert.ok(href?.[1]);
		assert.equal(decodeURIComponent(href[1]), diagramDrawio(diagram));
	});
});
