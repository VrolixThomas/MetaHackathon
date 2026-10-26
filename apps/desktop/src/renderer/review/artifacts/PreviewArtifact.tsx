import { useEffect, useMemo, useRef, useState } from "react";
import type { Preview, PreviewMarker } from "../../../shared/contracts";
import { Icon } from "../Icons";
import { previewFixtureDocument } from "./preview-fixture-document";
import {
	type PreviewMode,
	fixtureDocumentHeight,
	fixtureViewport,
	markerVisibility,
	previewScale,
	scrollToMarker,
	validatePreview,
	validateViewportResult,
} from "./preview-model";
import "./preview.css";

export type PreviewArtifactProps = {
	preview: Preview;
	onSelect: (marker: PreviewMarker) => void;
	onViewportChange?: (mode: PreviewMode) => Promise<Preview>;
};

export function PreviewArtifact(props: PreviewArtifactProps) {
	const parsed = useMemo(() => {
		try {
			return {
				preview: validatePreview(
					props.preview,
					typeof window === "undefined" ? undefined : window.location.origin
				),
			};
		} catch {
			return { error: "This preview has an invalid address, revision, or marker geometry." };
		}
	}, [props.preview]);
	if (!parsed.preview)
		return (
			<p className="pr-preview-error" role="alert">
				{parsed.error}
			</p>
		);
	return <PreviewSurface {...props} preview={parsed.preview} />;
}

function PreviewSurface({ preview, onSelect, onViewportChange }: PreviewArtifactProps) {
	const [current, setCurrent] = useState(preview);
	const [pendingMode, setPendingMode] = useState<PreviewMode | null>(null);
	const [error, setError] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [actualSize, setActualSize] = useState(false);
	const [interactive, setInteractive] = useState(false);
	const [reload, setReload] = useState(0);
	const [availableWidth, setAvailableWidth] = useState(280);
	const [scroll, setScroll] = useState({ x: 0, y: 0 });
	const viewportRef = useRef<HTMLElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const request = useRef(0);
	const fixture = current.evidence.kind === "fixture";
	const scale = previewScale(current.viewport, availableWidth, actualSize);
	const documentHeight = fixture ? fixtureDocumentHeight(current) : current.viewport.height;
	const srcDoc = useMemo(
		() => (current.evidence.kind === "fixture" ? previewFixtureDocument(current) : undefined),
		[current]
	);

	useEffect(() => {
		request.current += 1;
		setCurrent(preview);
		setPendingMode(null);
		setError("");
		setSelectedId(null);
		setInteractive(false);
		setScroll({ x: 0, y: 0 });
		viewportRef.current?.scrollTo({ top: 0, left: 0 });
	}, [preview]);
	useEffect(
		() => () => {
			request.current += 1;
		},
		[]
	);
	useEffect(() => {
		const element = stageRef.current;
		if (!element) return;
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width;
			if (width) setAvailableWidth(Math.max(100, width - 32));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const changeViewport = async (mode: PreviewMode) => {
		if (pendingMode || mode === current.viewport.mode) return;
		setError("");
		if (fixture) {
			setCurrent(fixtureViewport(current, mode));
			setScroll({ x: 0, y: 0 });
			viewportRef.current?.scrollTo({ top: 0, left: 0 });
			return;
		}
		if (!onViewportChange) return;
		const id = ++request.current;
		setPendingMode(mode);
		try {
			const result = await onViewportChange(mode);
			if (id !== request.current) return;
			const refreshed = validateViewportResult(current, result, mode, window.location.origin);
			setCurrent(refreshed);
			setInteractive(false);
			setScroll({ x: 0, y: 0 });
			setSelectedId(null);
			setReload((value) => value + 1);
		} catch {
			if (id === request.current)
				setError("Could not refresh this viewport. The previous page and markers are still shown.");
		} finally {
			if (id === request.current) setPendingMode(null);
		}
	};
	const selectMarker = (marker: PreviewMarker) => {
		setSelectedId(marker.id);
		if (fixture) {
			viewportRef.current?.scrollTo({
				top: scrollToMarker(marker, current.viewport, documentHeight) * scale,
				behavior: "smooth",
			});
		}
		onSelect(marker);
	};
	const sourceLabel = fixture
		? "Illustrative checkout"
		: new URL(current.url).host + new URL(current.url).pathname;
	return (
		<section
			className="pr-preview"
			aria-label="Checkout preview artifact"
			aria-busy={pendingMode !== null}
		>
			<div className="pr-preview-toolbar">
				<span className="pr-preview-address" title={sourceLabel}>
					<span className={`dot ${fixture ? "amber" : "blue"}`} />
					{sourceLabel}
				</span>
				<div className="segmented" aria-label="Preview viewport">
					{(["desktop", "phone"] as const).map((mode) => (
						<button
							type="button"
							key={mode}
							className={current.viewport.mode === mode ? "active" : ""}
							aria-pressed={current.viewport.mode === mode}
							disabled={
								pendingMode !== null ||
								(!fixture && !onViewportChange && mode !== current.viewport.mode)
							}
							onClick={() => void changeViewport(mode)}
						>
							{mode === "phone" ? "Phone" : "Desktop"}
						</button>
					))}
				</div>
			</div>
			<div className="pr-preview-meta">
				<span>
					{current.viewport.width} × {current.viewport.height} CSS px
				</span>
				<button type="button" onClick={() => setActualSize(!actualSize)}>
					{actualSize ? "Fit to panel" : "View at 100%"}
				</button>
			</div>
			<div className="pr-preview-stage" ref={stageRef}>
				<div
					className={`pr-preview-device ${current.viewport.mode}`}
					style={{ width: current.viewport.width * scale + 10 }}
				>
					<section
						className={`pr-preview-viewport ${fixture ? "fixture" : "live"}`}
						ref={viewportRef}
						aria-label={fixture ? "Scrollable illustrative checkout" : "Live checkout viewport"}
						tabIndex={fixture ? 0 : -1}
						style={{
							width: current.viewport.width * scale,
							height: current.viewport.height * scale,
						}}
						onScroll={(event) =>
							setScroll({
								x: event.currentTarget.scrollLeft / scale,
								y: event.currentTarget.scrollTop / scale,
							})
						}
					>
						<div
							className="pr-preview-scroll-space"
							style={{ width: current.viewport.width * scale, height: documentHeight * scale }}
						>
							<div
								className="pr-preview-canvas"
								style={{
									width: current.viewport.width,
									height: documentHeight,
									transform: `scale(${scale})`,
								}}
							>
								<iframe
									key={`${current.id}-${current.viewport.mode}-${reload}`}
									title={
										fixture ? "Illustrative capped checkout; no payments" : "Live local checkout"
									}
									src={fixture ? undefined : current.url}
									srcDoc={srcDoc}
									sandbox={fixture ? "" : "allow-scripts"}
									referrerPolicy="no-referrer"
									tabIndex={interactive ? 0 : -1}
									style={{
										width: current.viewport.width,
										height: documentHeight,
										pointerEvents: interactive && !fixture ? "auto" : "none",
									}}
									onError={() =>
										setError(
											"The local page could not be loaded. Check the preview runner and retry."
										)
									}
								/>
								{!interactive &&
									current.markers
										.filter(
											(marker) =>
												fixture ||
												markerVisibility(marker, current.viewport, { x: 0, y: 0 }) === "visible"
										)
										.map((marker) => (
											<button
												type="button"
												key={marker.id}
												className={`pr-preview-overlay ${selectedId === marker.id ? "selected" : ""}`}
												style={{
													left: marker.bounds.x,
													top: marker.bounds.y,
													width: marker.bounds.width,
													height: marker.bounds.height,
												}}
												aria-label={`Marker ${marker.number}: ${marker.label}`}
												title={`${marker.label} · ${marker.location.path}:${marker.location.startLine}`}
												onClick={() => selectMarker(marker)}
											>
												<span>{marker.number}</span>
											</button>
										))}
							</div>
						</div>
					</section>
				</div>
			</div>
			{pendingMode && (
				<output className="pr-preview-notice">Measuring the {pendingMode} viewport…</output>
			)}
			{error && (
				<p className="pr-preview-error" role="alert">
					{error}
				</p>
			)}
			{fixture ? (
				<p className="pr-preview-notice">
					Fixture illustration · no local server or payment is running.{" "}
					{current.viewport.mode === "phone"
						? "Scroll inside the phone to find Pay below the fold."
						: "The desktop illustration keeps Pay in view. Use 100% to inspect details."}
				</p>
			) : (
				<>
					<div className="pr-preview-interaction">
						<button
							type="button"
							className="button"
							onClick={() => {
								setInteractive(!interactive);
								if (interactive) setReload((value) => value + 1);
							}}
						>
							{interactive ? "Reload measured view" : "Interact with page"}
						</button>
						<span>
							{interactive
								? "Marker overlays hidden while the page can scroll."
								: "Recorded bounds at page start; page interaction is locked."}
						</span>
					</div>
					<p className="pr-preview-notice">
						Live scroll measurement is not connected. Marker buttons still open their source.{" "}
						{!onViewportChange && "Viewport changes need the runtime measurement adapter."}
					</p>
				</>
			)}
			<ol className="pr-preview-marker-list" aria-label="Preview markers">
				{current.markers.map((marker) => {
					const position = markerVisibility(
						marker,
						current.viewport,
						fixture ? scroll : { x: 0, y: 0 }
					);
					return (
						<li key={marker.id}>
							<button
								type="button"
								className={selectedId === marker.id ? "selected" : ""}
								onClick={() => selectMarker(marker)}
							>
								<span className="pr-preview-marker-number">{marker.number}</span>
								<span className="pr-preview-marker-copy">
									<strong>{marker.label}</strong>
									<span className="pr-preview-source">
										{marker.location.path}:{marker.location.startLine}
										{marker.location.endLine !== marker.location.startLine
											? `–${marker.location.endLine}`
											: ""}
									</span>
									{position !== "visible" && (
										<span className="pr-preview-position">
											{position === "below"
												? "Below the viewport"
												: position === "above"
													? "Above the viewport"
													: "Outside the viewport"}
											{fixture ? " · select to reveal" : " · source available"}
										</span>
									)}
								</span>
								<Icon name="arrow" size={13} />
							</button>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
