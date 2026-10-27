import { useState } from "react";
import { useStore } from "zustand";
import type { ReviewDetail } from "../../shared/contracts";
import type { PreparedController } from "./controller";

export function ReviewInbox({
	controller,
	onSelect,
}: { controller: PreparedController; onSelect(detail: ReviewDetail): void }) {
	const state = useStore(controller.store);
	const [repository, setRepository] = useState("");
	return (
		<aside className="repository-inbox" aria-label="Repository reviews">
			<button
				type="button"
				className="choose-repository"
				disabled={state.busy}
				onClick={() => void controller.chooseRepository()}
			>
				Choose local repository
			</button>
			<form
				className="repository-connect"
				onSubmit={(event) => {
					event.preventDefault();
					void controller.connect(repository);
				}}
			>
				<label htmlFor="repository-input">GitHub owner/repo</label>
				<input
					id="repository-input"
					name="repository"
					value={repository}
					onChange={(event) => setRepository(event.currentTarget.value)}
					placeholder="owner/repo"
					autoCapitalize="none"
					autoCorrect="off"
					spellCheck={false}
					required
				/>
				<button type="submit" disabled={state.busy}>
					Connect repository
				</button>
			</form>
			{state.error && (
				<p className="inline-error" role="alert">
					{state.error}
				</p>
			)}
			{state.inbox?.repository && (
				<div className="connected-repository">
					<strong>{state.inbox.repository}</strong>
					<button
						type="button"
						className="quiet"
						disabled={state.busy || state.inbox.refreshing}
						onClick={() => void controller.refresh()}
					>
						{state.inbox.refreshing ? "Refreshing…" : "Refresh"}
					</button>
				</div>
			)}
			{state.inbox?.localPath && (
				<p className="local-path" title={state.inbox.localPath}>
					{state.inbox.localPath}
				</p>
			)}
			{state.inbox?.error && (
				<p className="inline-error" role="alert">
					{state.inbox.error}
				</p>
			)}
			<div className="review-inbox-list">
				{state.inbox?.items.map((item) => (
					<div
						className="review-inbox-item"
						key={item.pr.id}
						data-pr-id={item.pr.id}
						data-review-status={item.status}
					>
						<button
							type="button"
							className="review-inbox-select"
							aria-current={state.detail?.pr.id === item.pr.id ? "true" : undefined}
							disabled={item.status !== "ready"}
							onClick={() => onSelect(item)}
						>
							<span>
								#{item.pr.number} · {item.pr.author}
							</span>
							<strong>{item.pr.title}</strong>
							<span className={`preparation-status ${item.status}`}>
								{item.status === "ready"
									? "Ready to review"
									: item.status === "preparing"
										? "Preparing review…"
										: item.status === "queued"
											? "Queued"
											: "Preparation failed"}
							</span>
						</button>
						{item.status === "error" && (
							<>
								<p className="inline-error">{item.error || "Review preparation failed."}</p>
								<button
									type="button"
									className="quiet"
									disabled={state.busy}
									onClick={() => void controller.prepare(item.pr.id)}
								>
									Retry preparation
								</button>
							</>
						)}
					</div>
				))}
			</div>
			{state.inbox?.repository && !state.inbox.refreshing && !state.inbox.items.length && (
				<p className="small">No open pull requests.</p>
			)}
			<p className="small">
				Open pull requests prepare in the background. Connecting a repository does not post
				comments.
			</p>
		</aside>
	);
}
