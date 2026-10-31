import { type KeyboardEvent, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import {
	type BrowserBounds,
	type Canvas,
	WORKSPACE_GITHUB_REQUIRED,
	type WorkspaceCommand,
	WorkspaceUrlSchema,
} from "../../shared/contracts";
import { CenterCanvas } from "../command-center/CenterCanvas";
import { FlowCanvas, SourceCanvas } from "../command-center/SourceCanvas";
import type { HubController } from "../command-center/controller";
import type { DayController } from "../day/controller";
import { ImageCanvas } from "../images";
import type { PRFixController } from "../pr-fixes";
import { ReviewWorkspace } from "../prepared/ReviewWorkspace";
import type { PreparedController } from "../prepared/controller";
import type { SlackBrowseController } from "../slack";
import { ArtifactCanvas } from "./ArtifactCanvas";
import { BrowserSurface } from "./BrowserSurface";
import { CanvasSplit } from "./CanvasSplit";
import { WorkspaceDialog } from "./WorkspaceDialog";
import type { WorkspaceController } from "./controller";
import type { LocalBrowserController } from "./local-browser";
import "./canvases.css";

const kindLabel = {
	center: "Workspace",
	source: "Source",
	flow: "Source flow",
	review: "Code",
	browser: "Browser",
	document: "Document",
	visual: "Visual",
	image: "Image",
};
const kindIcon = {
	center: "⌂",
	source: "‹›",
	flow: "↳",
	review: "‹›",
	browser: "◎",
	document: "▤",
	visual: "◇",
	image: "▧",
};

export function CanvasWorkspace({
	controller,
	reviews,
	browser,
	obscured,
	onOpenRepository,
	onOpenSettings,
	hub,
	day,
	slack,
	fixes,
	onManualInteraction,
}: {
	controller: WorkspaceController;
	reviews: PreparedController;
	browser: LocalBrowserController;
	obscured: boolean;
	onOpenRepository(): void;
	onOpenSettings?(): void;
	hub?: HubController;
	day?: DayController;
	slack?: SlackBrowseController;
	fixes?: PRFixController;
	onManualInteraction?(): void;
}) {
	const state = useStore(controller.store);
	const page = useStore(browser.store).page;
	const workspace = state.workspace;
	const [historyOpen, setHistoryOpen] = useState(false);
	const historyToggle = useRef<HTMLButtonElement>(null);
	const blocked = obscured || historyOpen;
	const saved =
		state.observation?.savedCanvases?.filter(
			(saved) => !workspace?.canvases.some((canvas) => canvas.id === saved.id)
		) ?? [];
	const tabs = useRef<HTMLDivElement>(null);
	const host = useRef<HTMLElement>(null);
	const sequence = workspace?.sequence;
	const browserShown =
		workspace?.canvases.some(
			(canvas) =>
				canvas.kind === "browser" &&
				(canvas.id === workspace.primaryId || canvas.id === workspace.secondaryId)
		) ?? false;
	const visibleTabs =
		workspace?.canvases.filter(
			(canvas) =>
				canvas.kind !== "center" || (canvas.selectedId && canvas.selectedId !== "connections")
		) ?? [];
	const primaryHasTab = visibleTabs.some((canvas) => canvas.id === workspace?.primaryId);
	const presented = useCallback(
		(bounds: BrowserBounds | null) => {
			if (sequence !== undefined) controller.presented(sequence, bounds);
		},
		[controller, sequence]
	);
	const failed = useCallback(() => {
		if (sequence !== undefined) controller.presentationFailed(sequence);
	}, [controller, sequence]);
	const primaryCanvas = workspace?.canvases.find((canvas) => canvas.id === workspace.primaryId);
	const slackTarget =
		primaryCanvas?.kind === "center" && primaryCanvas.section === "slack"
			? primaryCanvas.selectedId
			: undefined;
	const fixSource = primaryCanvas?.kind === "center" ? primaryCanvas.fixSource : undefined;
	useLayoutEffect(() => {
		controller.setObscured(blocked);
		if (sequence === undefined) return;
		let disposed = false;
		let secondFrame = 0;
		const sourceShown = () => {
			if (fixSource) {
				const selector = fixSource.path === null ? "[data-pr-fix-status-id]" : "[data-pr-fix-id]";
				return [...(host.current?.querySelectorAll<HTMLElement>(selector) ?? [])].some(
					(element) => {
						const rect = element.getBoundingClientRect();
						return (
							(element.getAttribute("data-pr-fix-id") ??
								element.getAttribute("data-pr-fix-status-id")) === fixSource.id &&
							element.getAttribute("data-pr-fix-head") === (fixSource.headSha ?? "pending") &&
							element.getAttribute("data-pr-fix-base") === fixSource.baseSha &&
							element.getAttribute("data-pr-fix-path") === (fixSource.path ?? "") &&
							rect.width > 0 &&
							rect.height > 0
						);
					}
				);
			}
			return (
				!slackTarget ||
				[...(host.current?.querySelectorAll<HTMLElement>("[data-slack-target]") ?? [])].some(
					(element) => {
						const rect = element.getBoundingClientRect();
						return (
							element.getAttribute("data-slack-target") === slackTarget &&
							rect.width > 0 &&
							rect.height > 0
						);
					}
				)
			);
		};
		const frame = requestAnimationFrame(() => {
			if (!sourceShown()) {
				controller.presentationFailed(sequence);
				return;
			}
			secondFrame = requestAnimationFrame(() =>
				sourceShown() ? controller.rendered(sequence) : controller.presentationFailed(sequence)
			);
		});
		if (!browserShown)
			void browser
				.present(null)
				.then(() => {
					if (!disposed) controller.presented(sequence, null);
				})
				.catch(() => {
					if (!disposed) controller.presentationFailed(sequence);
				});
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			cancelAnimationFrame(secondFrame);
		};
	}, [controller, browser, sequence, browserShown, blocked, slackTarget, fixSource]);
	const command = (input: WorkspaceCommand) => void controller.command(input);
	const tabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		const buttons = [...(tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
		const index = buttons.indexOf(event.target as HTMLButtonElement);
		if (index < 0) return;
		event.preventDefault();
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? buttons.length - 1
					: (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
		buttons[next]?.focus();
	};
	const renderCanvas = (canvas: Canvas, visible: boolean) => {
		if (canvas.kind === "image")
			return (
				<ImageCanvas
					asset={canvas.asset}
					read={controller.readImage}
					onReady={controller.imageReady}
				/>
			);
		if (!workspace) return null;
		if (canvas.kind === "center")
			return (
				<CenterCanvas
					canvas={canvas}
					hub={hub}
					day={day}
					slack={slack}
					fixes={fixes}
					beforeNavigate={onManualInteraction}
					command={command}
					onSettings={onOpenSettings}
				/>
			);
		if (canvas.kind === "source")
			return (
				<SourceCanvas
					source={canvas.source}
					onReference={(location) => command({ kind: "open-source", location })}
				/>
			);
		if (canvas.kind === "flow")
			return (
				<FlowCanvas
					flow={canvas.flow}
					onReference={(location) => command({ kind: "open-source", location })}
				/>
			);
		if (canvas.kind === "browser")
			return (
				<BrowserSurface
					controller={browser}
					visible={visible}
					onPresented={presented}
					onPresentationError={failed}
					onClose={() => command({ kind: "close-canvas", id: canvas.id })}
					onCommand={(action) =>
						command(
							action.kind === "navigate"
								? {
										kind: "open-browser",
										url: action.url,
										target: canvas.id === workspace.secondaryId ? "secondary" : "primary",
									}
								: { kind: "browser-action", action }
						)
					}
					onViewport={(mode) =>
						command({
							kind: "browser-action",
							action: {
								kind: "viewport",
								viewport:
									mode === "phone" ? { width: 390, height: 844 } : { width: 1024, height: 768 },
							},
						})
					}
				/>
			);
		if (canvas.kind === "review")
			return workspace.review.mode === "review" ? (
				<ReviewWorkspace
					controller={reviews}
					onInteraction={() => {}}
					view={workspace.codeView}
					onClose={() => command({ kind: "close-canvas", id: canvas.id })}
					onViewChange={(view) => {
						if (view !== workspace.codeView) command({ kind: "code-view", view });
					}}
					onNavigate={(navigation) => command({ kind: "navigate-review", ...navigation })}
				/>
			) : (
				<div className="review-empty">
					<span className="eyebrow">Workspace</span>
					<h1>What are we working on?</h1>
					<p>Talk to open a website, explore code, or create a document or visual.</p>
					<button type="button" onClick={onOpenRepository}>
						Open repository
					</button>
				</div>
			);
		return (
			<ArtifactCanvas
				canvas={canvas}
				onOpenUrl={(url) => {
					if (!WorkspaceUrlSchema.safeParse(url).success) {
						controller.store.setState({
							error: "Use HTTPS or a local HTTP address to open a link.",
						});
						return;
					}
					command({ kind: "open-browser", url });
				}}
				onReference={(reference) => {
					command({ kind: "open-source", location: reference });
				}}
			/>
		);
	};
	return (
		<section
			className="canvas-workspace"
			ref={host}
			aria-label="Workspace canvases"
			aria-busy={state.busy}
			data-workspace-sequence={sequence}
			data-primary-canvas={workspace?.primaryId}
			data-secondary-canvas={workspace?.secondaryId ?? ""}
		>
			{state.error && (
				<div className="canvas-error" role="alert">
					{state.error}
					{state.error === WORKSPACE_GITHUB_REQUIRED && onOpenSettings && (
						<button type="button" onClick={onOpenSettings}>
							Connect GitHub
						</button>
					)}
				</div>
			)}
			{workspace ? (
				<>
					{visibleTabs.length > 0 && (
						<div className="canvas-toolbar">
							<div
								ref={tabs}
								className="canvas-tablist"
								role="tablist"
								aria-label="Canvases"
								aria-multiselectable="true"
								onKeyDown={tabKeys}
							>
								{visibleTabs.map((canvas) => {
									const selected =
										canvas.id === workspace.primaryId || canvas.id === workspace.secondaryId;
									const title =
										canvas.kind === "browser" ? page?.title || canvas.title : canvas.title;
									return (
										<div key={canvas.id} className="canvas-tab" data-selected={selected}>
											<button
												type="button"
												role="tab"
												className="quiet"
												id={`canvas-tab-${canvas.id}`}
												aria-selected={selected}
												aria-controls={selected ? `canvas-panel-${canvas.id}` : undefined}
												tabIndex={
													canvas.id === workspace.primaryId ||
													(!primaryHasTab && canvas.id === visibleTabs[0]?.id)
														? 0
														: -1
												}
												title={title}
												onClick={() => {
													if (canvas.id !== workspace.primaryId)
														command({ kind: "focus-canvas", id: canvas.id });
												}}
											>
												<span
													className="canvas-tab-kind"
													title={kindLabel[canvas.kind]}
													aria-hidden="true"
												>
													{kindIcon[canvas.kind]}
												</span>
												<span className="canvas-tab-title">{title}</span>
											</button>
											<button
												type="button"
												className="quiet canvas-close"
												aria-label={`Close ${title}`}
												onClick={() => command({ kind: "close-canvas", id: canvas.id })}
											>
												×
											</button>
											{!selected && (
												<button
													type="button"
													className="quiet"
													aria-label={`Show ${title} beside current canvas`}
													disabled={state.busy || blocked}
													onClick={() =>
														command({ kind: "focus-canvas", id: canvas.id, target: "secondary" })
													}
												>
													◫
												</button>
											)}
										</div>
									);
								})}
							</div>
							{saved.length > 0 && (
								<button
									type="button"
									className="quiet canvas-layout-button"
									ref={historyToggle}
									aria-haspopup="dialog"
									aria-expanded={historyOpen}
									onClick={() => setHistoryOpen(true)}
								>
									Recent
								</button>
							)}
							{workspace.secondaryId ? (
								<button
									type="button"
									className="quiet canvas-layout-button"
									onClick={() =>
										command({ kind: "layout", primaryId: workspace.primaryId, secondaryId: null })
									}
									disabled={state.busy || blocked}
								>
									Single pane
								</button>
							) : (
								workspace.canvases.length > 1 && (
									<button
										type="button"
										className="quiet canvas-layout-button"
										disabled={state.busy || blocked}
										onClick={() => {
											const next = workspace.canvases.find(
												(canvas) => canvas.id !== workspace.primaryId
											);
											if (next) command({ kind: "focus-canvas", id: next.id, target: "secondary" });
										}}
									>
										Split panes
									</button>
								)
							)}
						</div>
					)}
					<CanvasSplit
						split={workspace.secondaryId !== null}
						obscured={blocked}
						renderPane={(pane, visible) => {
							const id = pane === "primary" ? workspace.primaryId : workspace.secondaryId;
							const canvas = workspace.canvases.find((canvas) => canvas.id === id);
							if (!canvas) return null;
							return (
								<div
									className="canvas-pane"
									role={visibleTabs.some((tab) => tab.id === canvas.id) ? "tabpanel" : "region"}
									id={`canvas-panel-${canvas.id}`}
									aria-labelledby={
										visibleTabs.some((tab) => tab.id === canvas.id)
											? `canvas-tab-${canvas.id}`
											: undefined
									}
									aria-label={
										!visibleTabs.some((tab) => tab.id === canvas.id) ? canvas.title : undefined
									}
									key={canvas.id}
									data-canvas-kind={canvas.kind}
									data-canvas-id={canvas.id}
									data-canvas-revision={canvas.revision}
								>
									{renderCanvas(canvas, visible)}
								</div>
							);
						}}
					/>
				</>
			) : (
				<div className="canvas-workspace-empty">Opening workspace…</div>
			)}
			{historyOpen && (
				<WorkspaceDialog
					id="canvas-history"
					title="Recent canvases"
					onClose={() => setHistoryOpen(false)}
					returnFocus={historyToggle}
					beforeOpen={() => browser.present(null)}
					onOpenError={() => {
						setHistoryOpen(false);
						if (sequence !== undefined) controller.presentationFailed(sequence);
					}}
				>
					<div className="canvas-history-list">
						{saved.map((canvas) => (
							<button
								type="button"
								key={canvas.id}
								onClick={() => {
									setHistoryOpen(false);
									controller.setObscured(false);
									command({ kind: "focus-canvas", id: canvas.id });
								}}
							>
								{canvas.title} <span className="small">{kindLabel[canvas.kind]}</span>
							</button>
						))}
					</div>
				</WorkspaceDialog>
			)}
		</section>
	);
}
