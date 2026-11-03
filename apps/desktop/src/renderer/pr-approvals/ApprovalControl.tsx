import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	type ApprovalPolicy,
	ApprovalPolicySchema,
	ApprovalPresentationSchema,
	type ApprovalTerms,
	ApprovalTermsSchema,
} from "../../shared/contracts";
import type { ConversationApi } from "../conversation/api";
import { WorkspaceDialog } from "../workspace/WorkspaceDialog";
import "./approvals.css";
import { ExactSourceCondition } from "./ExactSourceCondition";
import { ApprovalDialogLifecycle } from "./dialog-lifecycle";

const defaults = (): ApprovalTerms => ({
	action: "notify",
	expiresAt: new Date(Date.now() + 86400000).toISOString(),
	conditions: [{ kind: "check", name: "", appId: null }],
});
export function ApprovalControl({
	call,
	sessionId,
	beforeOpen,
	onOpenChange,
	canOpen = true,
	canCreate = false,
}: {
	call: ConversationApi["call"];
	sessionId: string;
	beforeOpen: () => Promise<void>;
	onOpenChange: (open: boolean) => void;
	canOpen?: boolean;
	canCreate?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [rows, setRows] = useState<ApprovalPolicy[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [terms, setTerms] = useState<ApprovalTerms>(defaults);
	const [consent, setConsent] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [connectionError, setConnectionError] = useState("");
	const [pending, setPending] = useState<z.infer<typeof ApprovalPresentationSchema> | null>(null);
	const node = useRef<HTMLDivElement>(null);
	const lifecycle = useRef(new ApprovalDialogLifecycle());
	const p = rows.find((p) => p.id === selected);
	const key = p ? `${p.id}:${p.revision}:${p.digest}` : "";
	const conditionKeys = useRef(Array.from({ length: 10 }, () => crypto.randomUUID()));
	useEffect(() => {
		onOpenChange(open);
		return () => onOpenChange(false);
	}, [open, onOpenChange]);
	useEffect(() => {
		let alive = true;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				const [raw, next] = await Promise.all([
					call("query", "prApprovals.list", {}),
					call("query", "prApprovals.pending", { sessionId }),
				]);
				const policies = z.array(ApprovalPolicySchema).max(100).parse(raw);
				const presentation = ApprovalPresentationSchema.nullable().parse(next);
				if (!alive) return;
				setRows(policies);
				setConnectionError("");
				setPending(presentation);
				const transition = lifecycle.current.observe(presentation, policies, canOpen);
				if (transition?.kind === "close") setOpen(false);
				if (transition?.kind === "open") {
					setSelected(transition.id);
					setEditing(false);
					setOpen(true);
				}
			} catch {
				if (alive)
					setConnectionError(
						"GitHub is unavailable. Last observed metadata is retained; approval requires fresh provider evidence."
					);
			} finally {
				if (alive) timer = setTimeout(poll, 1500);
			}
		};
		void poll();
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [call, sessionId, canOpen]);
	useEffect(() => {
		if (
			!open ||
			editing ||
			!p ||
			!pending ||
			pending.digest !== p.digest ||
			pending.id !== p.id ||
			pending.revision !== p.revision
		)
			return;
		let cancelled = false;
		let frame = 0;
		let matches = 0;
		const check = () => {
			if (cancelled) return;
			const el = node.current;
			const visible =
				el?.closest("dialog")?.open &&
				el.getBoundingClientRect().height > 0 &&
				el.dataset["approvalDigest"] === pending.digest &&
				document.visibilityState === "visible";
			matches = visible ? matches + 1 : 0;
			if (matches === 2) {
				void call("mutation", "prApprovals.presented", pending).catch(() => {});
				return;
			}
			frame = requestAnimationFrame(check);
		};
		frame = requestAnimationFrame(check);
		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
		};
	}, [open, editing, p, pending, call]);
	const run = async (work: () => Promise<void>) => {
		lifecycle.current.manual();
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await work();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not update delegation");
		} finally {
			setBusy(false);
		}
	};
	const save = () =>
		run(async () => {
			const value = ApprovalTermsSchema.parse(terms);
			const saved = ApprovalPolicySchema.parse(
				await call("mutation", "prApprovals.draft", {
					sessionId,
					terms: value,
					...(p ? { id: p.id, revision: p.revision } : {}),
				})
			);
			setRows((old) => [saved, ...old.filter((r) => r.id !== saved.id)]);
			setSelected(saved.id);
			setEditing(false);
			setConsent("");
		});
	return (
		<>
			{(canCreate || rows.length > 0 || open) && (
				<button
					type="button"
					aria-haspopup="dialog"
					aria-expanded={open}
					onClick={() => {
						lifecycle.current.manual();
						setOpen(true);
					}}
				>
					PR follow-up
				</button>
			)}
			{open && (
				<WorkspaceDialog
					id="pr-approvals"
					title="Conditional PR approval"
					beforeOpen={beforeOpen}
					onClose={() => {
						lifecycle.current.close();
						setOpen(false);
					}}
				>
					<div
						className="pr-approvals"
						aria-busy={busy}
						onPointerDownCapture={() => lifecycle.current.manual()}
						onKeyDownCapture={() => lifecycle.current.manual()}
					>
						<p>
							MuseFocus follows this PR while the app is running and your Mac is awake. Approving a
							PR never merges, publishes work or completes Linear.
						</p>
						{error && <p role="alert">{error}</p>}
						{connectionError && <output>{connectionError}</output>}
						<label>
							Saved delegation
							<select
								aria-label="Saved delegation"
								value={selected ?? ""}
								onChange={(e) => {
									setSelected(e.target.value || null);
									setEditing(false);
									setConsent("");
								}}
							>
								<option value="">Choose a delegation</option>
								{rows.map((r) => (
									<option value={r.id} key={r.id}>
										{r.pr.repository} #{r.pr.number} · {r.status}
									</option>
								))}
							</select>
						</label>
						<button
							type="button"
							disabled={busy || !canCreate}
							onClick={() => {
								setSelected(null);
								setTerms(defaults());
								setEditing(true);
								setConsent("");
							}}
						>
							New delegation for displayed PR
						</button>
						{editing ? (
							<form
								onSubmit={(e) => {
									e.preventDefault();
									void save();
								}}
							>
								<label>
									Action
									<select
										value={terms.action}
										onChange={(e) =>
											setTerms({ ...terms, action: e.target.value as ApprovalTerms["action"] })
										}
									>
										<option value="notify">Notify me only</option>
										<option value="approve">Automatically approve on GitHub</option>
									</select>
								</label>
								<label>
									Expires (UTC)
									<input
										aria-label="Expiry UTC"
										value={terms.expiresAt}
										onChange={(e) => setTerms({ ...terms, expiresAt: e.target.value })}
									/>
								</label>
								{terms.conditions.map((c, i) => (
									<fieldset key={conditionKeys.current[i]}>
										<legend>Condition {i + 1}</legend>
										<label>
											Evidence
											<select
												aria-label={`Condition ${i + 1} kind`}
												value={c.kind}
												onChange={(e) =>
													setTerms({
														...terms,
														conditions: terms.conditions.map((c, n) =>
															n !== i
																? c
																: e.target.value === "check"
																	? { kind: "check", name: "", appId: null }
																	: e.target.value === "source"
																		? { kind: "source", path: "", expectedContent: "", reason: "" }
																		: { kind: "judgment", description: "" }
														),
													})
												}
											>
												<option value="check">Successful GitHub check</option>
												<option value="source">Exact source replacement</option>
												<option value="judgment">Ask me for judgment</option>
											</select>
										</label>
										{c.kind === "check" ? (
											<>
												<label>
													Check name
													<input
														value={c.name}
														onChange={(e) =>
															setTerms({
																...terms,
																conditions: terms.conditions.map((r, n) =>
																	n === i ? { ...c, name: e.target.value } : r
																),
															})
														}
													/>
												</label>
												<label>
													GitHub app ID (optional)
													<input
														type="number"
														min="1"
														value={c.appId ?? ""}
														onChange={(e) =>
															setTerms({
																...terms,
																conditions: terms.conditions.map((r, n) =>
																	n === i
																		? {
																				...c,
																				appId: e.target.value ? Number(e.target.value) : null,
																			}
																		: r
																),
															})
														}
													/>
												</label>
											</>
										) : c.kind === "source" ? (
											<>
												<label>
													Exact file path
													<input
														value={c.path}
														onChange={(e) =>
															setTerms({
																...terms,
																conditions: terms.conditions.map((r, n) =>
																	n === i ? { ...c, path: e.target.value } : r
																),
															})
														}
													/>
												</label>
												<label>
													Reason
													<input
														value={c.reason}
														onChange={(e) =>
															setTerms({
																...terms,
																conditions: terms.conditions.map((r, n) =>
																	n === i ? { ...c, reason: e.target.value } : r
																),
															})
														}
													/>
												</label>
												<label>
													Expected complete file contents
													<textarea
														rows={8}
														maxLength={30000}
														value={c.expectedContent}
														onChange={(e) =>
															setTerms({
																...terms,
																conditions: terms.conditions.map((r, n) =>
																	n === i ? { ...c, expectedContent: e.target.value } : r
																),
															})
														}
													/>
												</label>
											</>
										) : (
											<label>
												Question requiring your judgment
												<textarea
													value={c.description}
													onChange={(e) =>
														setTerms({
															...terms,
															conditions: terms.conditions.map((r, n) =>
																n === i ? { ...c, description: e.target.value } : r
															),
														})
													}
												/>
											</label>
										)}
										<button
											type="button"
											disabled={terms.conditions.length === 1}
											onClick={() =>
												setTerms({
													...terms,
													conditions: terms.conditions.filter((_, n) => n !== i),
												})
											}
										>
											Remove condition
										</button>
									</fieldset>
								))}
								<button
									type="button"
									disabled={terms.conditions.length >= 10}
									onClick={() =>
										setTerms({
											...terms,
											conditions: [...terms.conditions, { kind: "check", name: "", appId: null }],
										})
									}
								>
									Add condition
								</button>
								<button type="submit" disabled={busy}>
									Review interpreted policy
								</button>
							</form>
						) : (
							p && (
								<div
									ref={node}
									data-approval-id={p.id}
									data-approval-revision={p.revision}
									data-approval-digest={p.digest}
									data-approval-status={p.status}
								>
									<p>
										<strong>
											{p.pr.repository} #{p.pr.number}
										</strong>{" "}
										· {p.status}
									</p>
									<p>
										GitHub account: {p.actor.login} (ID {p.actor.id})<br />
										Inspected head: <code>{p.pr.headSha}</code>
										<br />
										Policy revision {p.revision} · expires {p.terms.expiresAt}
									</p>
									<p>
										Action:{" "}
										<strong>
											{p.terms.action === "approve"
												? "Automatic GitHub approval"
												: "Notification only"}
										</strong>
									</p>
									<p>
										Scope: later commits must descend from this head and keep the PR base unchanged.
										Only the exact source replacements below are covered. Other changes require your
										review. Missing, ambiguous or unsuccessful checks block approval. Judgment
										conditions always require your decision.
									</p>
									<ol>
										{p.terms.conditions.map((c) => (
											<li
												key={
													c.kind === "check" ? c.name : c.kind === "source" ? c.path : c.description
												}
											>
												{c.kind === "check" ? (
													<>
														Successful check: {c.name} ·{" "}
														{c.appId === null ? "One unambiguous provider" : `App ${c.appId}`}
													</>
												) : c.kind === "judgment" ? (
													<>Human judgment: {c.description}</>
												) : (
													<ExactSourceCondition key={key} condition={c} />
												)}
											</li>
										))}
									</ol>
									{p.evaluation && (
										<>
											<p>
												Last evaluation: {p.evaluation.at} at <code>{p.evaluation.headSha}</code>
												<br />
												{p.evaluation.explanation}
											</p>
											<ul>
												{p.evaluation.evidence.map((e) => (
													<li key={`${e.kind}:${e.condition}:${e.detail}`}>
														{e.condition}: {e.satisfied ? "satisfied" : "not satisfied"} (
														{
															{
																source: "source",
																"github-check": "GitHub check result",
																inference: "inferred assessment",
															}[e.kind]
														}
														) — {e.detail}
														{e.url && (
															<a href={e.url} target="_blank" rel="noreferrer">
																Evidence
															</a>
														)}
													</li>
												))}
											</ul>
										</>
									)}
									{p.attempt && (
										<p>
											Approval attempt {p.attempt.id} at head <code>{p.attempt.headSha}</code>.
											Revoking this delegation stops future MuseFocus actions; it does not withdraw
											a submitted GitHub review.{" "}
											{p.attempt.receipt ? (
												<a href={p.attempt.receipt.url} target="_blank" rel="noreferrer">
													GitHub approval receipt #{p.attempt.receipt.id}
												</a>
											) : (
												"Provider outcome unconfirmed. No automatic retry."
											)}
										</p>
									)}
									{p.status === "draft" && (
										<>
											<label>
												<input
													type="checkbox"
													checked={consent === key}
													onChange={(e) => setConsent(e.target.checked ? key : "")}
												/>
												I authorize this exact policy, scope, expiry and action.
											</label>
											<button
												type="button"
												disabled={busy || consent !== key}
												onClick={() =>
													void run(async () => {
														const saved = ApprovalPolicySchema.parse(
															await call("mutation", "prApprovals.confirm", {
																id: p.id,
																revision: p.revision,
																digest: p.digest,
																confirmed: true,
															})
														);
														setRows((old) => old.map((r) => (r.id === saved.id ? saved : r)));
														setConsent("");
													})
												}
											>
												Confirm delegation
											</button>
										</>
									)}
									{!p.attempt && p.status !== "revoked" && (
										<button
											type="button"
											disabled={busy}
											onClick={() =>
												void run(async () => {
													await call("mutation", "prApprovals.beginEdit", {
														id: p.id,
														revision: p.revision,
													});
													setTerms(structuredClone(p.terms));
													setEditing(true);
													setConsent("");
												})
											}
										>
											Edit policy (requires confirmation)
										</button>
									)}
									{p.status !== "revoked" && (
										<button
											type="button"
											disabled={busy}
											onClick={() =>
												void run(async () => {
													await call("mutation", "prApprovals.revoke", {
														id: p.id,
														revision: p.revision,
													});
													setRows((old) =>
														old.map((r) => (r.id === p.id ? { ...r, status: "revoked" } : r))
													);
													setConsent("");
												})
											}
										>
											Revoke delegation
										</button>
									)}
								</div>
							)
						)}
					</div>
				</WorkspaceDialog>
			)}
		</>
	);
}
