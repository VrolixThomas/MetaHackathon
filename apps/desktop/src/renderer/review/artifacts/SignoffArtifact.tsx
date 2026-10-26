import { useId, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { DraftedComment, PRPreparation } from "../../../shared/contracts";
import type { ReviewFile } from "../model";
import type { DraftAdapter } from "../services";
import { draftContextError, reviewCoverage, signoffSession } from "./signoff-model";
import "./signoff.css";

export type SignoffArtifactProps = {
	preparation: PRPreparation;
	files: ReviewFile[];
	seen: string[];
	drafts: DraftedComment[];
	onOpenFile: (path: string) => void;
	onDraftChange: (draft: DraftedComment) => void;
	adapter: DraftAdapter | null;
};

function DraftCard({
	draft,
	preparation,
	onOpenFile,
	onDraftChange,
	adapter,
}: Pick<SignoffArtifactProps, "preparation" | "onOpenFile" | "onDraftChange" | "adapter"> & {
	draft: DraftedComment;
}) {
	const id = useId();
	const mounted = useRef(false);
	const session = signoffSession(draft, preparation);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const current = session.matches(draft, preparation);
	// Disable stale renders immediately; synchronize before the next browser interaction.
	useLayoutEffect(() => {
		session.sync(draft, preparation);
	});
	// An adapter change requires fresh consent, even when the draft is unchanged.
	// biome-ignore lint/correctness/useExhaustiveDependencies: adapter identity defines the posting service.
	useLayoutEffect(() => {
		mounted.current = true;
		session.setConsent(false);
		return () => {
			mounted.current = false;
			session.setConsent(false);
		};
	}, [session, adapter]);
	const contextError = draftContextError(state.draft, preparation);
	const location = state.draft.location;
	const busy = state.phase === "saving" || state.phase === "posting";
	const canEdit = current && session.canEdit && (session.fixture || !!adapter);
	const canConfirm = current && session.canConfirm && !!adapter;
	const save = async () => {
		session.sync(draft, preparation);
		const saved = await session.save(adapter);
		// A late save must not insert the previous review's draft into a new parent view.
		if (saved && mounted.current) onDraftChange(saved);
	};
	return (
		<article className="signoff-draft" aria-label={`Draft ${state.draft.id}`} aria-busy={busy}>
			<header className="signoff-draft-header">
				{location ? (
					<button
						type="button"
						className="signoff-source"
						disabled={!!contextError || !current}
						onClick={() => onOpenFile(location.path)}
					>
						{location.path}:{location.startLine}
						{location.endLine !== location.startLine ? `–${location.endLine}` : ""}
						<span>{location.revision === "base" ? "Before" : "This PR"} · open source</span>
					</button>
				) : (
					<strong className="signoff-general">PR comment</strong>
				)}
				<span className="signoff-badge">
					{session.fixture
						? "Fixture"
						: state.phase === "posted"
							? `Posted r${state.request?.draftRevision}`
							: "Draft"}
				</span>
			</header>
			<div className="signoff-words">
				<div>
					<span className="signoff-label">You said</span>
					<blockquote>{state.draft.originalWords}</blockquote>
				</div>
				<div>
					<label className="signoff-label" htmlFor={`${id}-body`}>
						Comment draft · revision {state.draft.revision}
					</label>
					<textarea
						id={`${id}-body`}
						value={state.body}
						rows={6}
						disabled={!canEdit}
						onChange={(event) => session.setBody(event.currentTarget.value)}
						spellCheck
					/>
				</div>
			</div>
			{session.dirty && (
				<div className="signoff-save">
					<button
						type="button"
						className="signoff-button"
						disabled={!canEdit || !state.body.trim()}
						onClick={() => void save()}
					>
						{state.phase === "saving" ? "Saving…" : "Save draft changes"}
					</button>
					<span>Save, then review the returned revision before confirming.</span>
				</div>
			)}
			{session.fixture ? (
				<p className="signoff-attention">
					Fixture draft · local edits only. Nothing can be posted.
				</p>
			) : state.phase !== "posted" ? (
				<>
					<label className="signoff-consent">
						<input
							type="checkbox"
							checked={current && session.confirmed}
							disabled={!canConfirm}
							onChange={(event) => session.setConsent(event.currentTarget.checked)}
						/>
						<span>
							I confirm this exact comment for PR #{preparation.pr.number}.
							<small>
								{state.draft.id} · revision {state.draft.revision} · head{" "}
								<code title={preparation.pr.headSha}>{preparation.pr.headSha.slice(0, 7)}</code>
							</small>
						</span>
					</label>
					<button
						type="button"
						className="signoff-button signoff-post"
						disabled={!canConfirm || !session.confirmed}
						onClick={() => {
							session.sync(draft, preparation);
							void session.post(adapter);
						}}
					>
						{state.phase === "posting"
							? "Posting…"
							: state.phase === "uncertain"
								? "Retry same confirmed request"
								: "Post confirmed comment"}
					</button>
					{!adapter && <p className="signoff-note">Posting needs a connected comment service.</p>}
				</>
			) : null}
			{contextError && <p className="signoff-attention">{contextError}</p>}
			{state.error && (
				<p className="signoff-attention" role="alert">
					{state.error}
				</p>
			)}
			{state.request && state.phase === "uncertain" && (
				<p className="signoff-note">
					Retained request: <code>{state.request.requestId}</code> · revision{" "}
					{state.request.draftRevision}. No automatic retry.
				</p>
			)}
			{state.notice && <output className="signoff-feedback">{state.notice}</output>}
			{state.url && (
				<a className="signoff-link" href={state.url} target="_blank" rel="noopener noreferrer">
					View posted comment
				</a>
			)}
		</article>
	);
}

export function SignoffArtifact({
	preparation,
	files,
	seen,
	drafts,
	onOpenFile,
	onDraftChange,
	adapter,
}: SignoffArtifactProps) {
	const coverage = reviewCoverage(preparation, files, seen);
	return (
		<section className="signoff-artifact" aria-label="Review sign-off">
			<header className="signoff-summary">
				<span className="signoff-label">From your session</span>
				<h3>
					{coverage.viewed} of {coverage.total} files marked seen
				</h3>
				<progress value={coverage.viewed} max={coverage.total || 1} aria-label="Files viewed" />
				<p className="signoff-note">
					Use “Mark as seen” in the code view to record your coverage. Coverage does not imply
					passing tests or approval.
				</p>
			</header>
			<div className="signoff-coverage">
				<h4>
					Still unseen <span>{coverage.unseen.length}</span>
				</h4>
				{coverage.unseen.length ? (
					<ul>
						{coverage.unseen.map((file) => (
							<li key={file.path}>
								<button type="button" onClick={() => onOpenFile(file.path)}>
									<code>{file.path}</code>
									<span>{file.purpose}</span>
									<small>Not seen · open file →</small>
								</button>
							</li>
						))}
					</ul>
				) : (
					<p className="signoff-note">
						{coverage.total
							? "Every listed file has been marked seen."
							: "No files are available yet."}
					</p>
				)}
			</div>
			<div className="signoff-drafts">
				<h4>
					Drafted from what you said <span>{drafts.length}</span>
				</h4>
				<p className="signoff-note">Nothing is posted until you confirm each saved comment.</p>
				{drafts.length ? (
					drafts.map((draft) => (
						<DraftCard
							key={`${preparation.pr.repository}:${draft.prId}:${draft.id}`}
							draft={draft}
							preparation={preparation}
							onOpenFile={onOpenFile}
							onDraftChange={onDraftChange}
							adapter={adapter}
						/>
					))
				) : (
					<p className="signoff-empty">
						No comments drafted yet. Ask your review companion to draft one.
					</p>
				)}
			</div>
		</section>
	);
}
