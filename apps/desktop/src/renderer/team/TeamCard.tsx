import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { ProposalBundle } from "../../../../../services/team/schemas";
import type { TeamController } from "./controller";
import "./team.css";

export interface TeamCardProps {
	controller: TeamController;
	repository?: string;
	prNumber?: number;
	candidateId?: string;
	onReviewApplied?: (jobId: string) => void;
}
export function TeamCard({
	controller,
	repository,
	prNumber,
	candidateId,
	onReviewApplied,
}: TeamCardProps) {
	const state = useStore(controller.store);
	const [name, setName] = useState("");
	const [repo, setRepo] = useState("");
	const identity = state.detail?.bundleDigest ?? state.preview?.bundleDigest ?? null;
	const [consent, setConsent] = useState({
		identity: null as string | null,
		share: false,
		decision: false,
		apply: false,
	});
	const shareConfirmed = consent.identity === identity && consent.share;
	const decisionConfirmed = consent.identity === identity && consent.decision;
	const applyConfirmed = consent.identity === identity && consent.apply;
	useEffect(() => {
		controller.setContext({ repository, prNumber, candidateId });
	}, [controller, repository, prNumber, candidateId]);
	useEffect(() => {
		void controller.start();
	}, [controller]);
	const connected = state.status?.connection === "connected";
	const busy = !!state.busy;
	const bundle = state.detail?.bundle ?? state.preview?.bundle;
	return (
		<section
			className="hub-setup team-card"
			aria-label="Team reviews"
			data-team-card="true"
			data-testid="team-card"
		>
			<div className="team-heading">
				<div>
					<h3>Team reviews</h3>
					<output aria-live="polite" data-testid="team-status">
						{state.status?.connection === "unconfigured"
							? "Team service is not configured."
							: state.status?.connection === "connecting"
								? "Continue sign-in in your browser."
								: connected
									? "Connected to your team service."
									: state.status?.connection === "offline"
										? "Team service is offline."
										: state.status
											? "Connect to share reviews with your organization."
											: "Checking team connection…"}
					</output>
				</div>
				{connected || state.status?.connection === "connecting" ? (
					<button
						type="button"
						className="quiet"
						data-testid="team-logout"
						onClick={() => void controller.logout()}
					>
						{" "}
						{state.status?.connection === "connecting" ? "Cancel sign-in" : "Disconnect team"}
					</button>
				) : (
					<button
						type="button"
						className="quiet"
						disabled={busy || !state.status?.configured}
						data-testid="team-login"
						onClick={() => void controller.login()}
					>
						Connect team
					</button>
				)}
			</div>
			{state.error && (
				<p className="inline-error" role="alert">
					{state.error}
				</p>
			)}
			{state.notice && <output>{state.notice}</output>}
			{connected && (
				<>
					<div className="team-onboarding">
						<label>
							Organization
							<select
								aria-label="Team organization"
								data-testid="team-organizations"
								value={state.orgId ?? ""}
								disabled={busy}
								onChange={(event) => void controller.chooseOrganization(event.target.value)}
							>
								<option value="" disabled>
									Choose an organization
								</option>
								{state.organizations.map((org) => (
									<option key={org.id} value={org.id}>
										{org.name}
									</option>
								))}
							</select>
						</label>
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void controller.createOrganization(name);
							}}
						>
							<label>
								New organization
								<input
									aria-label="New organization name"
									value={name}
									maxLength={160}
									disabled={busy}
									onChange={(event) => setName(event.target.value)}
								/>
							</label>
							<button type="submit" disabled={busy || !name.trim()}>
								Create organization
							</button>
						</form>
					</div>
					{state.orgId && (
						<>
							<div
								className="team-repositories"
								aria-label="Team repositories"
								data-testid="team-repositories"
							>
								{state.repositories.length === 0 && <p>No authorized repositories in this page.</p>}
								{state.repositories.map((item) => {
									const selected = state.status?.scopes.some(
										(scope) =>
											scope.orgId === item.orgId && scope.repositoryId === item.repositoryId
									);
									return (
										<div key={item.repositoryId} className="team-repository">
											<code>{item.fullName}</code>
											<button
												type="button"
												disabled={busy || selected}
												data-testid="team-select-scope"
												onClick={() => void controller.selectScope(item.orgId, item.repositoryId)}
											>
												{selected ? "Shared preparation selected" : "Use shared preparation"}
											</button>
										</div>
									);
								})}
								{state.nextRepositoryOffset !== null && (
									<button
										type="button"
										disabled={busy}
										onClick={() => void controller.moreRepositories()}
									>
										More repositories
									</button>
								)}
							</div>
							<form
								onSubmit={(event) => {
									event.preventDefault();
									void controller.registerRepository(repo);
								}}
							>
								<label>
									Register repository
									<input
										aria-label="Repository owner/name"
										value={repo}
										placeholder="owner/repository"
										disabled={busy}
										onChange={(event) => setRepo(event.target.value)}
									/>
								</label>
								<button type="submit" disabled={busy || !repo.trim()}>
									Register repository
								</button>
								<p className="small">
									Registration requires your GitHub administrator access and the organization’s
									GitHub App installation.
								</p>
							</form>
						</>
					)}
					<div className="team-heading">
						<h4>
							Shared proposals{state.context.prNumber ? ` for PR #${state.context.prNumber}` : ""}
						</h4>
						<button
							type="button"
							disabled={busy}
							onClick={() => void controller.refreshProposals()}
						>
							Refresh proposals
						</button>
					</div>
					{!state.proposals.length && (
						<p className="small">No proposals loaded for the selected repository.</p>
					)}
					<ul className="team-proposal-list" data-testid="team-proposals">
						{state.proposals.map((item) => (
							<li key={item.id}>
								<button
									type="button"
									disabled={busy}
									onClick={() => void controller.readProposal(item.id)}
								>
									PR #{item.key.prNumber} ·{" "}
									{item.decision?.decision === "accept"
										? "Accepted"
										: item.decision?.decision === "decline"
											? "Declined"
											: "Awaiting author decision"}{" "}
									· {item.createdAt}
								</button>
							</li>
						))}
					</ul>
					{state.nextOffset !== null && (
						<button type="button" disabled={busy} onClick={() => void controller.moreProposals()}>
							More proposals
						</button>
					)}
					{candidateId && state.status?.canShare && (
						<button type="button" disabled={busy} onClick={() => void controller.previewLocal()}>
							Review local fix for sharing
						</button>
					)}
					{bundle && (
						<div
							className="team-proposal-review"
							data-team-proposal={state.detail?.id ?? state.preview?.candidateId}
							data-team-proposal-id={state.detail?.id}
							data-team-bundle-digest={identity ?? ""}
						>
							<ProposalSources bundle={bundle} />
							<details>
								<summary>Content identity</summary>
								<code>{identity}</code>
								<p>
									Sources <code>{bundle.sourcesDigest}</code>
								</p>
								<p>
									Checks <code>{bundle.checksDigest}</code>
								</p>
								<p>
									Patch <code>{bundle.patch.sha256}</code>
								</p>
							</details>
							{state.preview && !state.detail && (
								<div className="team-confirm">
									<label>
										<input
											type="checkbox"
											checked={shareConfirmed}
											disabled={busy}
											onChange={(event) =>
												setConsent({
													identity,
													share: event.target.checked,
													decision: false,
													apply: false,
												})
											}
										/>
										Share this exact source, patch and check bundle with this organization.
									</label>
									<button
										type="button"
										disabled={busy || !shareConfirmed}
										onClick={() => void controller.shareProposal(shareConfirmed)}
									>
										Share exact proposal
									</button>
								</div>
							)}
							{state.detail && !state.detail.decision && (
								<div className="team-confirm">
									<p>Only the current PR author can record a decision.</p>
									<label>
										<input
											type="checkbox"
											checked={decisionConfirmed}
											disabled={busy}
											onChange={(event) =>
												setConsent({
													identity,
													share: false,
													decision: event.target.checked,
													apply: false,
												})
											}
										/>
										Confirm my decision for this exact proposal.
									</label>
									<button
										type="button"
										disabled={busy || !decisionConfirmed}
										onClick={() => void controller.decideProposal("accept", decisionConfirmed)}
									>
										Accept proposal
									</button>
									<button
										type="button"
										className="quiet"
										disabled={busy || !decisionConfirmed}
										onClick={() => void controller.decideProposal("decline", decisionConfirmed)}
									>
										Decline proposal
									</button>
								</div>
							)}
							{state.detail?.decision && (
								<output>
									Author decision:{" "}
									{state.detail.decision.decision === "accept" ? "accepted" : "declined"}.
								</output>
							)}
							{state.detail?.decision?.decision === "accept" &&
								state.detail.decision.authorId === state.status?.userId &&
								state.status?.canApply && (
									<div className="team-confirm">
										<label>
											<input
												type="checkbox"
												checked={applyConfirmed}
												disabled={busy}
												onChange={(event) =>
													setConsent({
														identity,
														share: false,
														decision: false,
														apply: event.target.checked,
													})
												}
											/>
											Apply this accepted fix locally.
										</label>
										<button
											type="button"
											disabled={
												busy ||
												!applyConfirmed ||
												state.applyReceipt?.status === "pending" ||
												state.applyReceipt?.status === "applied"
											}
											onClick={() => void controller.applyProposal(applyConfirmed)}
										>
											Apply accepted fix locally
										</button>
									</div>
								)}
							{state.applyReceipt && (
								<output data-testid="team-apply-status">
									{state.applyReceipt.status === "applied"
										? `Applied locally at ${state.applyReceipt.appliedHeadSha}`
										: state.applyReceipt.status === "pending"
											? "Application status is pending. Inspect the local result before trying again."
											: (state.applyReceipt.message ?? "The local application did not complete.")}
								</output>
							)}
							{state.applyReceipt?.status === "applied" && state.applyReceipt.jobId && (
								<button
									type="button"
									className="quiet"
									onClick={() => onReviewApplied?.(state.applyReceipt?.jobId ?? "")}
									disabled={!onReviewApplied}
								>
									Review applied fix
								</button>
							)}
						</div>
					)}
				</>
			)}
		</section>
	);
}
function ProposalSources({ bundle }: { bundle: ProposalBundle }) {
	return (
		<>
			<h4>Exact candidate review</h4>
			<p className="small">Shared local candidate. Checks below are reported by its submitter.</p>
			<blockquote>{bundle.feedback.body}</blockquote>
			<p className="small">
				Feedback {bundle.feedback.kind} #{bundle.feedback.id} · revision {bundle.feedback.revision}
			</p>
			<p className="team-identity">
				Base <code>{bundle.baseSha}</code>
				<br />
				Candidate <code>{bundle.candidateSha}</code>
			</p>
			{bundle.files.map((file) => (
				<details key={file.path} open>
					<summary>{file.path}</summary>
					<div className="team-source-pair">
						<div>
							<h5>Before</h5>
							<pre
								data-team-source-path={file.path}
								data-team-source-sha={bundle.baseSha}
								data-team-source-side="before"
							>
								<code>{file.before?.text ?? "File absent"}</code>
							</pre>
						</div>
						<div>
							<h5>Proposed after</h5>
							<pre
								data-team-source-path={file.path}
								data-team-source-sha={bundle.candidateSha}
								data-team-source-side="after"
							>
								<code>{file.after?.text ?? "File absent"}</code>
							</pre>
						</div>
					</div>
				</details>
			))}
			<details open>
				<summary>Exact patch</summary>
				<pre data-team-patch="true">
					<code>{bundle.patch.text}</code>
				</pre>
			</details>
			<details open>
				<summary>Checks ({bundle.checks.length})</summary>
				{bundle.checks.length === 0 ? (
					<p>No check results supplied.</p>
				) : (
					bundle.checks.map((check, index) => (
						<div key={`${check.startedAt}:${index}`} className="team-check">
							<code>{check.command.map((arg) => JSON.stringify(arg)).join(" ")}</code>
							<p>
								Exit {check.exitCode} · {check.startedAt} → {check.finishedAt}
							</p>
							<p>{check.environment}</p>
							<p className="small">
								Commit <code>{check.commitSha}</code> · Output <code>{check.output.sha256}</code>
							</p>
							<pre>
								<code>{check.output.text}</code>
							</pre>
						</div>
					))
				)}
			</details>
		</>
	);
}
