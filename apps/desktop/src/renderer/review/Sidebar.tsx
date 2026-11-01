import { useState } from "react";
import { BrandMark } from "../brand/Brand";
import { Icon } from "./Icons";
import { useReview } from "./controller";
import { cancelRuntimeAction, loadLocalDemo, useRuntimeAction } from "./runtime-actions";
import { useServices } from "./services";
import { readingRoute } from "./workspace-data";

export function Sidebar({
	onSettings,
	voiceStatus,
	onTalkStart,
	onTalkEnd,
}: {
	onSettings: () => void;
	voiceStatus: string;
	onTalkStart: () => void;
	onTalkEnd: () => void;
}) {
	const { sourceMode, preparation, files, file, cursor, seen, openFile, setPanel, announce } =
		useReview();
	const [expanded, setExpanded] = useState(true);
	const [showSeen, setShowSeen] = useState(false);
	const [showMechanical, setShowMechanical] = useState(false);
	const route = readingRoute(files);
	const mechanical = preparation.files.filter((f) => f.category.startsWith("mechanical"));
	const isFixture = sourceMode === "reference";
	const runtime = useServices((state) => state.runtime);
	const action = useRuntimeAction();
	const checked = route.filter((f) => seen.includes(f.path));
	return (
		<aside className="sidebar" aria-label="Review sidebar">
			<div className="sidebar-brand">
				<BrandMark size={24} />
				<strong>MuseFocus</strong>
				<span className="brand-tag">REVIEW</span>
			</div>
			<div className="sidebar-scroll">
				{runtime && (
					<div className="runtime-entry">
						<button
							type="button"
							className="button"
							disabled={action.busy}
							onClick={() => void loadLocalDemo()}
						>
							{action.busy
								? "Working…"
								: sourceMode === "reference"
									? "Load local demo"
									: "Reload local demo"}
						</button>
						{action.busy && (
							<button type="button" className="text-button" onClick={cancelRuntimeAction}>
								Cancel
							</button>
						)}
					</div>
				)}
				<div className="section-label">
					<span>Needs you</span>
					<span>{isFixture ? 3 : 1}</span>
				</div>
				<button
					type="button"
					className="pr-row expanded"
					onClick={() => setExpanded(!expanded)}
					aria-expanded={expanded}
				>
					<span className={expanded ? "chevron down" : "chevron"}>
						<Icon name="chevron" size={14} />
					</span>
					<span className="pr-info">
						<span className="pr-meta">
							{preparation.pr.repository.split("/").at(-1)} <span>#{preparation.pr.number}</span>
						</span>
						<strong>{preparation.pr.title}</strong>
						<span className="attention-text">
							<span className="dot amber" />{" "}
							{isFixture ? "Breaks a nightly job · fixture" : preparation.status}
						</span>
					</span>
				</button>
				{expanded && (
					<nav className="file-route" aria-label="Files in reading order">
						<div className="route-label">
							YOUR READING ROUTE{" "}
							<span>
								{checked.length}/{route.length}
							</span>
						</div>
						{route
							.filter(
								(f) =>
									!seen.includes(f.path) ||
									showSeen ||
									f.path === file ||
									route[cursor]?.path === f.path
							)
							.map((f) => {
								const index = route.indexOf(f);
								return (
									<button
										type="button"
										key={f.path}
										className={`file-row ${f.path === file ? "selected" : ""} ${cursor === index ? "keyboard-current" : ""}`}
										aria-current={f.path === file ? "page" : undefined}
										onClick={() => openFile(f.path)}
										title={f.path}
									>
										<span className={`file-number ${seen.includes(f.path) ? "seen" : ""}`}>
											{seen.includes(f.path) ? <Icon name="check" size={14} /> : index + 1}
										</span>
										<span className="file-info">
											<span className="filename">{f.path.split("/").at(-1)}</span>
											<span className={f.attention === "decide" ? "attention-text" : "muted"}>
												{f.purpose}
											</span>
										</span>
									</button>
								);
							})}
						{checked.length > 0 && (
							<button
								type="button"
								className="collapse-row"
								aria-expanded={showSeen}
								onClick={() => setShowSeen(!showSeen)}
							>
								<Icon name="check" size={13} />
								{checked.length} seen {showSeen ? "· collapse" : "· show"}
							</button>
						)}
						<button
							type="button"
							className="collapse-row"
							aria-expanded={showMechanical}
							onClick={() => setShowMechanical(!showMechanical)}
						>
							<span className={showMechanical ? "chevron down" : "chevron"}>
								<Icon name="chevron" size={13} />
							</span>
							{mechanical.length} mechanical{" "}
							{mechanical.every((f) => f.category === "mechanical-verified")
								? "checked"
								: "candidate"}
						</button>
						{showMechanical && (
							<div className="mechanical-detail">
								{mechanical.map((item) => (
									<div key={item.path}>
										<button
											type="button"
											className="text-button"
											onClick={() => openFile(item.path)}
										>
											{item.path}
										</button>
										<p>{item.reason}</p>
									</div>
								))}
							</div>
						)}
					</nav>
				)}
				{isFixture ? (
					<>
						<button
							type="button"
							className="pr-row other-pr"
							onClick={() =>
								announce(
									"Finance #412 depends on #1284 adding orders.promo_code. This is reference fixture metadata."
								)
							}
						>
							<Icon name="chevron" size={14} />
							<span className="pr-info">
								<span className="pr-meta">
									finance-service <span>#412</span>
								</span>
								<strong>Read promo_code in export</strong>
								<span className="blue-text">Merge after #1284</span>
							</span>
						</button>
						<button
							type="button"
							className="pr-row other-pr"
							onClick={() =>
								announce(
									"#1291 is a reference fixture for a mechanical dependency update. No review data is connected yet."
								)
							}
						>
							<Icon name="chevron" size={14} />
							<span className="pr-info">
								<span className="pr-meta">
									shop-web <span>#1291</span>
								</span>
								<strong>Bump image library to 3.2</strong>
								<span className="muted">Nothing needs you</span>
							</span>
						</button>
						<div className="section-label updates-label">
							<span>Updates</span>
							<span>2</span>
						</div>
						<button
							type="button"
							className="update-row"
							onClick={() => {
								setPanel("conversation");
								announce("Reference update: Noor replied, ‘Good catch. I'll skip expired codes.’");
							}}
						>
							<span className="dot blue" />
							<span>
								<strong>Noor replied on #1284</strong>
								<span>“Good catch. I'll skip expired codes.”</span>
							</span>
						</button>
						<button
							type="button"
							className="update-row"
							onClick={() => {
								setPanel("conversation");
								announce("Reference update: Product answered, ‘The quoted price should hold.’");
							}}
						>
							<span className="dot dim" />
							<span>
								<strong>Product answered on #1284</strong>
								<span>“The quoted price should hold.”</span>
							</span>
						</button>
						<div className="section-label">
							<span>Preparing</span>
							<span>1</span>
						</div>
						<div className="preparing-row">
							<span className="pr-meta">
								shop-web <span>#1288</span>
							</span>
							<strong>Retry failed webhooks</strong>
							<span>Reference preparation · 3 of 6</span>
							<div className="progress-track">
								<span />
							</div>
						</div>
					</>
				) : (
					<>
						<div className="section-label">
							Updates <span>0</span>
						</div>
						<p className="mechanical-detail">No new updates.</p>
						<div className="section-label">
							Preparing <span>0</span>
						</div>
					</>
				)}
			</div>
			<div className="sidebar-bottom">
				<button
					type="button"
					className={`talk-control ${voiceStatus === "Listening" ? "listening" : ""}`}
					onPointerDown={(event) => {
						if (event.button !== 0) return;
						event.currentTarget.setPointerCapture(event.pointerId);
						onTalkStart();
					}}
					onPointerUp={onTalkEnd}
					onPointerCancel={onTalkEnd}
					onLostPointerCapture={onTalkEnd}
					onBlur={onTalkEnd}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.code === "Space") {
							event.preventDefault();
							if (!event.repeat) onTalkStart();
						}
					}}
					onKeyUp={(event) => {
						if (event.key === "Enter" || event.code === "Space") {
							event.preventDefault();
							onTalkEnd();
						}
					}}
					aria-label="Hold to talk"
				>
					<span className="mic-circle">
						<Icon name="mic" size={18} />
					</span>
					<span>
						<strong>{voiceStatus}</strong>
						<span>
							Hold <kbd>space</kbd> to talk
						</span>
					</span>
				</button>
				<button
					type="button"
					className="icon-button"
					title="Settings"
					aria-label="Open settings"
					onClick={onSettings}
				>
					<Icon name="settings" size={17} />
				</button>
			</div>
		</aside>
	);
}
