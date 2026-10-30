import { useState } from "react";
import { useStore } from "zustand";
import type { DayWorkItem } from "../../shared/contracts/day";
import { DayFeedback } from "./DayFeedback";
import type { DayController } from "./controller";
import { activeDayItems, phasePresentation, sourceVisibility } from "./model";

export interface DayQueueProps {
	controller: DayController;
	selectedId?: string;
	/** Root opens the item through its acknowledged workspace command. */
	onOpenItem(id: string): void;
}

/** Contextual sidebar content only. Root's category browsing preserves the visible canvas. */
export function DayQueue({ controller, selectedId, onOpenItem }: DayQueueProps) {
	const { snapshot, loading, busy, error } = useStore(controller.store);
	const [title, setTitle] = useState("");
	const active = snapshot ? activeDayItems(snapshot.items) : [];
	const finished =
		snapshot?.items.filter((item) => ["closed", "cancelled"].includes(item.phase)) ?? [];
	const row = (item: DayWorkItem) => (
		<li key={item.id}>
			<button
				type="button"
				className="command-item quiet"
				aria-current={selectedId === item.id ? "true" : undefined}
				onClick={() => onOpenItem(item.id)}
			>
				<span className="command-item-title">{item.title}</span>
				<span className="command-item-meta">
					{item.acceptance === "pending" ? "Acceptance pending · " : ""}
					{phasePresentation[item.phase].label}
				</span>
				<span className="command-item-meta">{sourceVisibility(item)}</span>
			</button>
		</li>
	);
	return (
		<section className="day-queue" aria-label="Your day items" aria-busy={loading}>
			<header className="day-queue-heading">
				<span>{snapshot ? `${active.length} open` : "Your day"}</span>
				<button
					type="button"
					className="quiet"
					disabled={loading}
					onClick={() => void controller.refresh()}
				>
					Refresh
				</button>
			</header>
			{!snapshot ? (
				<DayFeedback
					state={error ? "error" : "loading"}
					onRetry={() => void controller.refresh()}
				/>
			) : (
				<>
					{error && <p role="alert">{error}</p>}
					{snapshot.errors.length > 0 && (
						<p role="alert" className="hub-sidebar-empty">
							Some day sources or background actions are unavailable. Open an item to check its
							saved state.
						</p>
					)}
					{active.length ? (
						<ul className="day-queue-list">{active.map(row)}</ul>
					) : error || snapshot.errors.length > 0 ? (
						<p className="hub-sidebar-empty">Refresh to check for open commitments.</p>
					) : (
						<DayFeedback state="empty" />
					)}
					{finished.length > 0 && (
						<details>
							<summary>Closed and cancelled · {finished.length}</summary>
							<ul className="day-queue-list">{finished.map(row)}</ul>
						</details>
					)}
				</>
			)}
			<details className="day-capture">
				<summary>Capture a commitment</summary>
				<form
					className="day-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (!title.trim() || busy) return;
						void controller
							.operate({
								kind: "capture_manual",
								title: title.trim(),
								summary: "",
								itemKind: "follow_up",
							})
							.then((result) => {
								if (result) setTitle((current) => (current === title ? "" : current));
							});
					}}
				>
					<label>
						What needs following up?
						<input
							required
							maxLength={300}
							value={title}
							onChange={(event) => setTitle(event.target.value)}
						/>
					</label>
					<p className="day-hint">Private to you. You can add context when you cover the item.</p>
					<button type="submit" disabled={busy || !snapshot || !title.trim()}>
						Capture
					</button>
				</form>
			</details>
		</section>
	);
}
