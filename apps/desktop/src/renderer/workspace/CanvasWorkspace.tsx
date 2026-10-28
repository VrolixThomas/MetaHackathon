import { type KeyboardEvent, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import {
	type BrowserBounds,
	type Canvas,
	type WorkspaceCommand,
	WorkspaceUrlSchema,
} from "../../shared/contracts";
import { ReviewWorkspace } from "../prepared/ReviewWorkspace";
import type { PreparedController } from "../prepared/controller";
import { ArtifactCanvas } from "./ArtifactCanvas";
import { BrowserSurface } from "./BrowserSurface";
import { CanvasSplit } from "./CanvasSplit";
import { WorkspaceDialog } from "./WorkspaceDialog";
import type { WorkspaceController } from "./controller";
import type { LocalBrowserController } from "./local-browser";
import "./canvases.css";

const kindLabel = { review: "Code", browser: "Browser", document: "Document", visual: "Visual" };

export function CanvasWorkspace({
	controller,
	reviews,
	browser,
	obscured,
	onOpenRepository,
}: {
	controller: WorkspaceController;
	reviews: PreparedController;
	browser: LocalBrowserController;
	obscured: boolean;
	onOpenRepository(): void;
}) {
	const state = useStore(controller.store);
	const workspace = state.workspace;
	const [historyOpen, setHistoryOpen] = useState(false);
	const historyToggle = useRef<HTMLButtonElement>(null);
	const blocked = obscured || historyOpen;
	const saved =
		state.observation?.savedCanvases?.filter(
			(saved) => !workspace?.canvases.some((canvas) => canvas.id === saved.id)
		) ?? [];
	const tabs = useRef<HTMLDivElement>(null);
	const sequence = workspace?.sequence;
	const browserShown =
		workspace?.canvases.some(
			(canvas) =>
				canvas.kind === "browser" &&
				(canvas.id === workspace.primaryId || canvas.id === workspace.secondaryId)
		) ?? false;
	const presented = useCallback(
		(bounds: BrowserBounds | null) => {
			if (sequence !== undefined) controller.presented(sequence, bounds);
		},
		[controller, sequence]
	);
	const failed = useCallback(() => {
		if (sequence !== undefined) controller.presentationFailed(sequence);
	}, [controller, sequence]);
	useLayoutEffect(() => {
		controller.setObscured(blocked);
		if (sequence === undefined) return;
		let disposed = false;
		let secondFrame = 0;
		const frame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => controller.rendered(sequence));
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
	}, [controller, browser, sequence, browserShown, blocked]);
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
		if (!workspace) return null;
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
					const selected = reviews.store.getState().detail?.pr;
					if (
						!selected ||
						selected.repository !== reference.repository ||
						reference.commitSha !==
							(reference.revision === "base" ? selected.baseSha : selected.headSha)
					) {
						controller.store.setState({
							error: "Open the matching PR revision to follow this source reference.",
						});
						return;
					}
					command({
						kind: "navigate-review",
						path: reference.path,
						side: reference.revision,
						line: reference.startLine,
					});
				}}
			/>
		);
	};
	return (
		<section
			className="canvas-workspace"
			aria-label="Workspace canvases"
			data-workspace-sequence={sequence}
			data-primary-canvas={workspace?.primaryId}
			data-secondary-canvas={workspace?.secondaryId ?? ""}
		>
			{state.error && (
				<p className="canvas-error" role="alert">
					{state.error}
				</p>
			)}
			{workspace ? (
				<>
					<div className="canvas-toolbar">
						<div
							ref={tabs}
							className="canvas-tablist"
							role="tablist"
							aria-label="Canvases"
							aria-multiselectable="true"
							onKeyDown={tabKeys}
						>
							{workspace.canvases.map((canvas) => {
								const selected =
									canvas.id === workspace.primaryId || canvas.id === workspace.secondaryId;
								return (
									<div key={canvas.id} className="canvas-tab" data-selected={selected}>
										<button
											type="button"
											role="tab"
											className="quiet"
											id={`canvas-tab-${canvas.id}`}
											aria-selected={selected}
											aria-controls={selected ? `canvas-panel-${canvas.id}` : undefined}
											tabIndex={canvas.id === workspace.primaryId ? 0 : -1}
											title={canvas.title}
											onClick={() => {
												if (canvas.id !== workspace.primaryId)
													command({ kind: "focus-canvas", id: canvas.id });
											}}
										>
											<span className="canvas-tab-kind">{kindLabel[canvas.kind]}</span>
											{canvas.title}
										</button>
										<button
											type="button"
											className="quiet canvas-close"
											aria-label={`Close ${canvas.title}`}
											onClick={() => command({ kind: "close-canvas", id: canvas.id })}
										>
											×
										</button>
										{!selected && (
											<button
												type="button"
												className="quiet"
												aria-label={`Show ${canvas.title} beside current canvas`}
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
							>
								Single pane
							</button>
						) : (
							workspace.canvases.length > 1 && (
								<button
									type="button"
									className="quiet canvas-layout-button"
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
									role="tabpanel"
									id={`canvas-panel-${canvas.id}`}
									aria-labelledby={`canvas-tab-${canvas.id}`}
									key={canvas.id}
									data-canvas-kind={canvas.kind}
									data-canvas-id={canvas.id}
									data-canvas-revision={canvas.revision}
								>
									{workspace.secondaryId && (
										<div className="canvas-pane-heading">
											<strong>{canvas.title}</strong>
											<span>{pane === "primary" ? "Primary" : "Secondary"}</span>
										</div>
									)}
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
