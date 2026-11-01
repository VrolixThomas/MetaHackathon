import { useState } from "react";
import type { DayWorkItem } from "../../shared/contracts/day";
import type { DayController } from "./controller";

export function DayClarification({
	item,
	controller,
	busy,
}: { item: DayWorkItem; controller: DayController; busy: boolean }) {
	const [scope, setScope] = useState("");
	const [maxMessages, setMaxMessages] = useState(2);
	const [durationMinutes, setDurationMinutes] = useState(30);
	const [inspection, setInspection] = useState<{ key: string; item: DayWorkItem } | null>(null);
	const [reading, setReading] = useState(false);
	const [readError, setReadError] = useState("");
	if (!item.source) return null;
	const inspectionKey = `${item.workspaceId}:${item.ownerUserId}:${item.id}:${item.revision}`;
	const c =
		item.clarification ??
		(inspection?.key === inspectionKey ? inspection.item.clarification : undefined);
	const version = { itemId: item.id, expectedRevision: item.revision };
	const terminal = ["closed", "cancelled"].includes(item.phase);
	return (
		<section className="day-section" aria-label="Slack clarification">
			<h2>Delegate clarification</h2>
			<p>
				MuseFocus can ask bounded questions in the original Slack thread. Ownership, coding work and
				final delivery need separate authority.
			</p>
			{item.clarificationMetadata && !c && (
				<>
					<output>Clarification: {item.clarificationMetadata.status.replaceAll("_", " ")}</output>
					<p>
						Read the current source to inspect the delegation, thread evidence and inferred brief.
					</p>
					<button
						type="button"
						disabled={busy || reading}
						onClick={() => {
							setReading(true);
							setReadError("");
							void controller
								.inspectClarification(item)
								.then((value) => setInspection({ key: inspectionKey, item: value }))
								.catch(() => {
									setInspection(null);
									setReadError(
										"The current thread could not be authorized. Retry when source access is available."
									);
								})
								.finally(() => setReading(false));
						}}
					>
						Inspect current clarification
					</button>
				</>
			)}
			{readError && <p role="alert">{readError}</p>}
			{c && (
				<>
					<output>
						Clarification: {c.status.replaceAll("_", " ")}
						{c.reason ? ` · ${c.reason.replaceAll("_", " ")}` : ""}
					</output>
					<details open={c.status === "proposed"}>
						<summary>Inspect delegation and original request</summary>
						<blockquote className="day-exact-text">{c.policy.originalRequest}</blockquote>
						<p>Scope: {c.policy.scope}</p>
						<p>
							Account: {c.policy.actor.userId} · Workspace: {c.policy.actor.workspaceId}
						</p>
						<p>
							Permitted conversation: {c.policy.source.conversationId} · Thread:{" "}
							{c.policy.source.threadId ?? c.policy.source.messageId}
						</p>
						<p>
							Authority: clarification questions only, without approving each message. Up to{" "}
							{c.policy.maxMessages} messages / rounds, at most three questions each, for{" "}
							{c.policy.durationMinutes} minutes from confirmation.
						</p>
						<p>No secrets, new destinations, expanded scope, commitments or execution.</p>
						{c.expiresAt && (
							<p>
								Expires:{" "}
								<time dateTime={c.expiresAt}>{new Date(c.expiresAt).toLocaleString()}</time>
							</p>
						)}
					</details>
					{c.status === "proposed" && !terminal && (
						<button
							type="button"
							disabled={busy}
							onClick={() =>
								void controller.operate({
									kind: "confirm_clarification",
									...version,
									policyId: c.policy.id,
									policyRevision: c.policy.revision,
								})
							}
						>
							Authorize this clarification delegation
						</button>
					)}
					{c.status === "active" && (
						<button
							type="button"
							disabled={busy}
							onClick={() => void controller.operate({ kind: "pause_clarification", ...version })}
						>
							Pause clarification
						</button>
					)}
					{!terminal && c.status !== "revoked" && (
						<button
							type="button"
							disabled={busy}
							onClick={() => void controller.operate({ kind: "revoke_clarification", ...version })}
						>
							Revoke delegation
						</button>
					)}
					{c.summary && (
						<p className="day-exact-text">Clarification brief · inferred: {c.summary}</p>
					)}
					{!!c.missing.length && (
						<>
							<h3>Missing context</h3>
							<ul>
								{c.missing.map((text) => (
									<li key={text}>{text}</li>
								))}
							</ul>
						</>
					)}
					{!!c.attempts.length && (
						<>
							<h3>Questions and delivery</h3>
							{c.attempts.map((a) => (
								<div key={a.requestId}>
									<p className="day-exact-text">{a.body}</p>
									<p>
										{a.status === "delivered"
											? "Verified Slack receipt"
											: a.status === "uncertain"
												? "Send outcome uncertain · do not resend"
												: "Queued, not delivered"}
									</p>
								</div>
							))}
						</>
					)}
					{!!c.evidence.length && (
						<details>
							<summary>Observed thread evidence · private to its source audience</summary>
							{c.evidence.map((m) => (
								<blockquote key={m.citation.source.messageId}>
									<p>
										{m.authorId} · {m.citation.source.messageId} · revision{" "}
										{m.citation.source.revisionId}
									</p>
									<p className="day-exact-text">{m.text}</p>
								</blockquote>
							))}
						</details>
					)}
					<p>
						Next:{" "}
						{c.status === "active"
							? "MuseFocus will check the original thread while this delegation is active."
							: c.status === "complete"
								? "Review the brief and authorize any work separately."
								: c.status === "needs_user"
									? "Your judgment is needed. Inspect the thread and missing context before issuing a new delegation."
									: "No automatic questions will be sent."}
					</p>
				</>
			)}
			{!terminal && (c?.status ?? item.clarificationMetadata?.status) !== "active" && (
				<details>
					<summary>Prepare a new delegation</summary>
					<form
						className="day-form"
						onSubmit={(e) => {
							e.preventDefault();
							if (!busy && scope.trim())
								void controller.operate({
									kind: "propose_clarification",
									...version,
									scope: scope.trim(),
									maxMessages,
									durationMinutes,
								});
						}}
					>
						<label>
							Permitted clarification scope
							<textarea
								required
								maxLength={1000}
								value={scope}
								onChange={(e) => setScope(e.target.value)}
							/>
						</label>
						<label>
							Maximum messages / rounds
							<input
								type="number"
								min={1}
								max={3}
								value={maxMessages}
								onChange={(e) => setMaxMessages(Number(e.target.value))}
							/>
						</label>
						<label>
							Minutes from confirmation
							<input
								type="number"
								min={5}
								max={120}
								value={durationMinutes}
								onChange={(e) => setDurationMinutes(Number(e.target.value))}
							/>
						</label>
						<button type="submit" disabled={busy || !scope.trim()}>
							Review delegation proposal
						</button>
					</form>
				</details>
			)}
		</section>
	);
}
