import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Preview } from "../../../shared/contracts";
import { getReviewFixture } from "../../../shared/fixtures/review";
import { PreviewArtifact } from "./PreviewArtifact";
import { previewFixtureDocument } from "./preview-fixture-document";
import {
	fixtureDocumentHeight,
	fixtureViewport,
	markerVisibility,
	previewScale,
	scrollToMarker,
	validatePreview,
	validateViewportResult,
} from "./preview-model";

function livePreview(): Preview {
	const preview = getReviewFixture().preview;
	return {
		...preview,
		evidence: {
			kind: "execution",
			runId: "measured-run",
			commitSha: preview.commitSha,
			command: ["preview"],
			startedAt: "2026-10-26T12:00:00Z",
			completedAt: "2026-10-26T12:00:01Z",
			exitCode: 0,
			logUrl: "file:///tmp/preview.log",
		},
	};
}

describe("preview artifact boundaries", () => {
	it("never loads the fixture localhost address or puts executable code in its document", () => {
		const preview = getReviewFixture().preview;
		const document = previewFixtureDocument(preview);
		assert.match(document, /Illustrative checkout/);
		assert.match(document, /€120\.00/);
		assert.match(document, /€72\.00/);
		assert.doesNotMatch(document, /<script|<form|src=|http:\/\//i);
		const markup = renderToStaticMarkup(
			createElement(PreviewArtifact, { preview, onSelect: () => {} })
		);
		assert.match(markup, /srcDoc=/);
		assert.match(markup, /sandbox=""/);
		assert.doesNotMatch(markup, /src="http:\/\/localhost/);
		assert.throws(() => previewFixtureDocument(livePreview()));
	});

	it("keeps the Pay marker below the phone fold until its document is scrolled", () => {
		const preview = getReviewFixture().preview;
		const marker = preview.markers.find((item) => item.id === "pay");
		assert.ok(marker);
		assert.equal(markerVisibility(marker, preview.viewport, { x: 0, y: 0 }), "below");
		const height = fixtureDocumentHeight(preview);
		const top = scrollToMarker(marker, preview.viewport, height);
		assert.equal(top, height - preview.viewport.height);
		assert.equal(markerVisibility(marker, preview.viewport, { x: 0, y: top }), "visible");
		assert.equal(markerVisibility(marker, preview.viewport, { x: 400, y: top }), "outside");
	});

	it("fits CSS pixels into the panel without changing the embedded viewport", () => {
		const { viewport } = getReviewFixture().preview;
		assert.equal(previewScale(viewport, 250, true), 1);
		assert.equal(previewScale(viewport, 250, false), 480 / 844);
		assert.equal(previewScale({ mode: "desktop", width: 1280, height: 800 }, 320, false), 0.25);
		assert.equal(viewport.width, 390);
	});

	it("makes fixture viewport variants without mutating shared evidence or source locations", () => {
		const original = getReviewFixture().preview;
		const snapshot = structuredClone(original);
		const desktop = fixtureViewport(original, "desktop");
		assert.deepEqual(original, snapshot);
		assert.equal(desktop.viewport.width, 1280);
		assert.deepEqual(desktop.evidence, original.evidence);
		assert.deepEqual(
			desktop.markers.map((marker) => marker.location),
			original.markers.map((marker) => marker.location)
		);
		const pay = desktop.markers.find((marker) => marker.id === "pay");
		assert.ok(pay);
		assert.equal(markerVisibility(pay, desktop.viewport, { x: 0, y: 0 }), "visible");
		assert.deepEqual(fixtureViewport(desktop, "phone"), original);
		assert.throws(() => fixtureViewport(livePreview(), "desktop"));
	});

	it("rejects unsafe, same-origin, stale and unreasonable live preview inputs", () => {
		const live = livePreview();
		for (const url of [
			"javascript:alert(1)",
			"https://example.com",
			"http://localhost.evil.test",
			"http://user:password@localhost:3000",
		]) {
			assert.throws(() => validatePreview({ ...live, url }));
		}
		assert.throws(() => validatePreview(live, "http://localhost:3000"));
		assert.throws(() => validatePreview({ ...live, evidence: { ...live.evidence, exitCode: 1 } }));
		assert.throws(() =>
			validatePreview({ ...live, viewport: { ...live.viewport, width: 100_000 } })
		);
		assert.throws(() =>
			validatePreview({
				...live,
				markers: live.markers.map((marker) => ({
					...marker,
					bounds: { ...marker.bounds, y: 100_000 },
				})),
			})
		);
		assert.equal(
			validatePreview({ ...live, url: "http://[::1]:3456/checkout" }).viewport.mode,
			"phone"
		);
	});

	it("accepts only freshly measured geometry for the requested PR, revision and mode", () => {
		const previous = livePreview();
		const next = { ...previous, viewport: { mode: "desktop" as const, width: 1280, height: 800 } };
		assert.deepEqual(validateViewportResult(previous, next, "desktop"), next);
		assert.throws(() => validateViewportResult(previous, getReviewFixture().preview, "phone"));
		assert.throws(() => validateViewportResult(previous, next, "phone"));
		assert.throws(() =>
			validateViewportResult(previous, { ...next, prId: "another-pr" }, "desktop")
		);
		assert.throws(() => validateViewportResult(previous, { ...next, revision: "base" }, "desktop"));
		assert.throws(() =>
			validateViewportResult(previous, { ...next, commitSha: "3".repeat(40) }, "desktop")
		);
	});
});
