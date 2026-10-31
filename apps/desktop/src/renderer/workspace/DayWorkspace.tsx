import { useState } from "react";
import { useStore } from "zustand";
import type { WorkspaceCommand } from "../../shared/contracts";
import type { HubController } from "../command-center/controller";
import { DayWorkItem } from "../day";
import type { DayController } from "../day/controller";

export function DayWorkspace({
	day,
	hub,
	itemId,
	command,
}: {
	day: DayController;
	hub?: HubController;
	itemId?: string;
	command(input: WorkspaceCommand): void;
}) {
	const state = useStore(day.store);
	if (!itemId)
		return (
			<section className="hub-empty" aria-label="My day">
				<h1>My day</h1>
				<p>Choose a commitment in the sidebar, or tell Muse what you want to remember.</p>
				{state.snapshot?.currentItemId && (
					<button
						type="button"
						onClick={() =>
							command({
								kind: "open-center",
								section: "day",
								selectedId: state.snapshot?.currentItemId ?? undefined,
							})
						}
					>
						Resume current item
					</button>
				)}
			</section>
		);
	return (
		<div data-center-section="day" data-selected-id={itemId}>
			<DayWorkItem controller={day} itemId={itemId} command={command} />
			{hub && <StartDayWork day={day} hub={hub} itemId={itemId} />}
		</div>
	);
}

function StartDayWork({
	day,
	hub,
	itemId,
}: { day: DayController; hub: HubController; itemId: string }) {
	const state = useStore(day.store);
	const repositories = useStore(hub.store).snapshot?.repositories ?? [];
	const [selected, setSelected] = useState("");
	const item = state.snapshot?.items.find((row) => row.id === itemId);
	if (
		!item ||
		item.acceptance !== "accepted" ||
		item.jobId ||
		["closed", "cancelled"].includes(item.phase)
	)
		return null;
	const repositoryId =
		selected || item.repositoryId || (repositories.length === 1 ? repositories[0]?.id : "");
	return (
		<section className="day-item" aria-label="Start background work">
			<h2>Work on this</h2>
			{repositories.length ? (
				<>
					<label>
						Repository{" "}
						<select
							value={repositoryId}
							onChange={(event) => setSelected(event.currentTarget.value)}
						>
							<option value="">Choose repository</option>
							{repositories.map((row) => (
								<option key={row.id} value={row.id}>
									{row.repository}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						disabled={state.busy || !repositoryId}
						onClick={() =>
							void day.operate({
								kind: "start_work",
								itemId: item.id,
								expectedRevision: item.revision,
								repositoryId: repositoryId as string,
							})
						}
					>
						Start background work
					</button>
				</>
			) : (
				<p>Add a repository in Connections before starting coding work.</p>
			)}
		</section>
	);
}
