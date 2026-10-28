import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { LinearScope, RepositoryChoice } from "../../shared/contracts";
import type { HubController } from "./controller";

export function HubConnections({ hub, onSettings }: { hub: HubController; onSettings?(): void }) {
	const { snapshot } = useStore(hub.store);
	return (
		<div className="hub-connections" aria-label="Connections">
			{(["github", "linear", "model"] as const).map((key) => (
				<span key={key} data-connected={snapshot?.connections[key] ?? false}>
					<i />
					{{ github: "GitHub", linear: "Linear", model: "Muse / Meta" }[key]} ·{" "}
					{snapshot ? (snapshot.connections[key] ? "Configured" : "Not configured") : "Checking…"}
				</span>
			))}
			{onSettings && (
				<button type="button" className="quiet" onClick={onSettings}>
					Settings ↗
				</button>
			)}
		</div>
	);
}

export function Connections({ hub, onSettings }: { hub: HubController; onSettings?(): void }) {
	const { snapshot, busy } = useStore(hub.store);
	const [choices, setChoices] = useState<RepositoryChoice[]>([]);
	const [scopes, setScopes] = useState<LinearScope[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState("");
	const [revision, setRevision] = useState(0);
	const [repository, setRepository] = useState("");
	const [path, setPath] = useState("");
	const [pickerBusy, setPickerBusy] = useState(false);
	const [selection, setSelection] = useState<string[] | null>(null);
	const [autoApply, setAutoApply] = useState<boolean | null>(null);
	const [workers, setWorkers] = useState<number | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry reloads provider choices.
	useEffect(() => {
		let current = true;
		setLoading(true);
		setLoadError("");
		void Promise.allSettled([hub.repositories(), hub.linearScopes()]).then(
			([repositories, linear]) => {
				if (!current) return;
				if (repositories.status === "fulfilled") setChoices(repositories.value);
				if (linear.status === "fulfilled") setScopes(linear.value);
				if (repositories.status === "rejected" || linear.status === "rejected")
					setLoadError("Some connection choices are unavailable. Check Settings and retry.");
				setLoading(false);
			}
		);
		return () => {
			current = false;
		};
	}, [hub, revision]);
	const selected = selection ?? [
		...(snapshot?.preferences.linearTeamIds ?? []),
		...(snapshot?.preferences.linearProjectIds ?? []),
	];
	const selectedTeams = scopes
		.filter((scope) => scope.kind === "team" && selected.includes(scope.id))
		.map((scope) => scope.id);
	const selectedProjects = scopes
		.filter((scope) => scope.kind === "project" && selected.includes(scope.id))
		.map((scope) => scope.id);
	const add = async () => {
		const result = await hub.operate({
			kind: "add-repository",
			repository: repository.trim(),
			...(path.trim() ? { localPath: path.trim() } : {}),
		});
		if (result) {
			setRepository("");
			setPath("");
		}
	};
	return (
		<section className="hub-setup" aria-label="Workspace connections">
			<h2>Connect your work</h2>
			<p className="hub-muted">
				Choose repositories and the Linear teams or projects you want to follow.
			</p>
			<HubConnections hub={hub} onSettings={onSettings} />
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void add();
				}}
				className="hub-form"
			>
				<label>
					GitHub repository
					<select
						value={repository}
						onChange={(event) => setRepository(event.currentTarget.value)}
						disabled={loading || busy}
					>
						<option value="">Choose a repository…</option>
						{repository && !choices.some((choice) => choice.repository === repository) && (
							<option value={repository}>{repository}</option>
						)}
						{choices.map((choice) => (
							<option key={choice.repository} value={choice.repository}>
								{choice.repository}
								{choice.private ? " · private" : ""}
							</option>
						))}
					</select>
				</label>
				<label>
					Local checkout path{" "}
					<span className="hub-muted">(optional for reviews, required for local coding)</span>
					<input
						value={path}
						onChange={(event) => setPath(event.currentTarget.value)}
						placeholder="Choose a local checkout below"
					/>
				</label>
				<div className="hub-actions">
					<button type="submit" disabled={!repository || busy}>
						{snapshot?.repositories.some((repo) => repo.repository === repository)
							? "Connect checkout"
							: "Add repository"}
					</button>
					<button
						type="button"
						className="quiet"
						disabled={pickerBusy || busy}
						onClick={() => {
							setPickerBusy(true);
							void hub
								.chooseRepository()
								.then((chosen) => {
									if (chosen) {
										setRepository(chosen.repository);
										setPath(chosen.localPath);
									}
								})
								.catch(() => setLoadError("The local repository could not be selected. Try again."))
								.finally(() => setPickerBusy(false));
						}}
					>
						{pickerBusy ? "Choosing…" : "Choose local checkout…"}
					</button>
				</div>
			</form>
			{loading && (
				<p aria-live="polite" className="hub-muted">
					Loading repository and scope choices…
				</p>
			)}
			{loadError && (
				<p className="hub-error" role="alert">
					{loadError}{" "}
					<button type="button" className="quiet" onClick={() => setRevision((value) => value + 1)}>
						Retry
					</button>
				</p>
			)}
			{snapshot?.repositories.map((repo) => (
				<div className="hub-connected-repo" key={repo.id}>
					<div>
						<strong>{repo.repository}</strong>
						<small>{repo.localPath ?? "No local checkout connected"}</small>
					</div>
					<button
						type="button"
						className="quiet"
						disabled={busy}
						onClick={() => void hub.operate({ kind: "remove-repository", repositoryId: repo.id })}
					>
						Remove
					</button>
				</div>
			))}
			{snapshot && (
				<form
					className="hub-form hub-scopes"
					onSubmit={(event) => {
						event.preventDefault();
						// Retain saved scopes omitted from a bounded provider response.
						const known = new Set(scopes.map((scope) => scope.id));
						void hub.operate({
							kind: "preferences",
							preferences: {
								linearTeamIds: [
									...snapshot.preferences.linearTeamIds.filter((id) => !known.has(id)),
									...selectedTeams,
								],
								linearProjectIds: [
									...snapshot.preferences.linearProjectIds.filter((id) => !known.has(id)),
									...selectedProjects,
								],
								maxWorkers: workers ?? snapshot.preferences.maxWorkers,
								autoApplySuggestions: autoApply ?? snapshot.preferences.autoApplySuggestions,
							},
						});
					}}
				>
					<fieldset disabled={loading || busy}>
						<legend>Linear scopes</legend>
						<div className="hub-scope-options">
							{scopes.map((scope) => (
								<label key={scope.id}>
									<input
										type="checkbox"
										checked={selected.includes(scope.id)}
										onChange={(event) =>
											setSelection(
												event.currentTarget.checked
													? [...selected, scope.id]
													: selected.filter((id) => id !== scope.id)
											)
										}
									/>
									<span>
										{scope.name}
										<small>
											{scope.kind}
											{scope.key ? ` · ${scope.key}` : ""}
										</small>
									</span>
								</label>
							))}
						</div>
						{!loading && !scopes.length && (
							<p className="hub-muted">
								{snapshot.connections.linear
									? "No teams or projects are available."
									: "Configure LINEAR_API_KEY in Settings, then reload connections."}
							</p>
						)}
					</fieldset>
					<label>
						Concurrent coding workers
						<select
							value={workers ?? snapshot.preferences.maxWorkers}
							onChange={(event) => setWorkers(Number(event.currentTarget.value))}
						>
							{[1, 2, 3, 4].map((value) => (
								<option key={value} value={value}>
									{value}
								</option>
							))}
						</select>
					</label>
					<label className="hub-checkbox">
						<input
							type="checkbox"
							checked={autoApply ?? snapshot.preferences.autoApplySuggestions}
							onChange={(event) => setAutoApply(event.currentTarget.checked)}
						/>
						Apply verified review suggestions after successful checks
					</label>
					<p className="hub-muted">
						Only exact-head suggestions with recorded successful checks qualify. Other feedback
						remains a decision.
					</p>
					<button type="submit" disabled={loading || busy}>
						Save preferences
					</button>
				</form>
			)}
		</section>
	);
}
