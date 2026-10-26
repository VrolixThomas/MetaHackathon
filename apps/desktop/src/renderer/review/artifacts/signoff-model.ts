import {
	type ConfirmCommentInput,
	ConfirmCommentInputSchema,
	type DraftedComment,
	DraftedCommentSchema,
	type PRPreparation,
} from "../../../shared/contracts";
import type { ReviewFile } from "../model";
import type { DraftAdapter } from "../services";

export function reviewCoverage(preparation: PRPreparation, files: ReviewFile[], seen: string[]) {
	const paths = new Map(
		[...preparation.files]
			.sort((a, b) => a.readingOrder - b.readingOrder)
			.map((file) => [file.path, { path: file.path, purpose: file.reason }])
	);
	for (const file of files) paths.set(file.path, { path: file.path, purpose: file.purpose });
	const visited = new Set(seen);
	const unseen = [...paths.values()].filter((file) => !visited.has(file.path));
	return { total: paths.size, viewed: paths.size - unseen.length, unseen };
}

function reviewIdentity(preparation: PRPreparation) {
	return JSON.stringify([
		preparation.pr,
		preparation.status,
		preparation.evidence.kind,
		preparation.files.map((file) => file.path),
	]);
}

function confirmationIdentity(draft: DraftedComment) {
	return JSON.stringify([draft.prId, draft.id, draft.revision, draft.body, draft.headSha]);
}

export function draftContextError(draft: DraftedComment, preparation: PRPreparation) {
	if (draft.prId !== preparation.pr.id) return "This draft belongs to a different pull request.";
	if (draft.headSha !== preparation.pr.headSha)
		return "The PR head has changed. Refresh this draft before confirming.";
	const location = draft.location;
	if (
		location &&
		(location.repository !== preparation.pr.repository ||
			location.commitSha !==
				(location.revision === "base" ? preparation.pr.baseSha : preparation.pr.headSha) ||
			!preparation.files.some((file) => file.path === location.path))
	)
		return "The draft source does not match this review. Refresh the draft.";
	if (preparation.status !== "ready") return "Wait until the pull request is ready to review.";
	return null;
}

export type SignoffDraftState = {
	draft: DraftedComment;
	body: string;
	consent: string | null;
	phase: "idle" | "saving" | "posting" | "uncertain" | "posted";
	request: ConfirmCommentInput | null;
	url: string | null;
	error: string;
	notice: string;
};

/** One session owns the synchronous submission lock and the original idempotency key.
 * Kept across panel unmounts below; main still owns durable deduplication and head checks.
 */
export class SignoffDraftSession {
	private state: SignoffDraftState;
	private preparation: PRPreparation;
	private incoming: string;
	private context: string;
	private generation = 0;
	private listeners = new Set<() => void>();

	constructor(
		draft: DraftedComment,
		preparation: PRPreparation,
		private requestId: () => string = () => crypto.randomUUID()
	) {
		this.state = {
			draft: DraftedCommentSchema.parse(draft),
			body: draft.body,
			consent: null,
			phase: "idle",
			request: null,
			url: null,
			error: "",
			notice: "",
		};
		this.preparation = preparation;
		this.incoming = JSON.stringify(draft);
		this.context = reviewIdentity(preparation);
	}

	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	private update(patch: Partial<SignoffDraftState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}

	matches(draft: DraftedComment, preparation: PRPreparation) {
		return this.incoming === JSON.stringify(draft) && this.context === reviewIdentity(preparation);
	}

	/** Changes invalidate consent even if a later render restores the previous head/body. */
	sync(draft: DraftedComment, preparation: PRPreparation) {
		if (this.matches(draft, preparation)) return;
		this.generation += 1;
		this.incoming = JSON.stringify(draft);
		this.context = reviewIdentity(preparation);
		this.preparation = preparation;
		this.update({
			draft: DraftedCommentSchema.parse(draft),
			body: draft.body,
			consent: null,
			error: this.state.request ? this.state.error : "",
			notice: this.state.request
				? this.state.notice
				: "Review the current draft and confirm again before posting.",
		});
	}

	get fixture() {
		return (
			this.state.draft.evidence.kind === "fixture" || this.preparation.evidence.kind === "fixture"
		);
	}
	get dirty() {
		return this.state.body !== this.state.draft.body;
	}
	get contextError() {
		return draftContextError(this.state.draft, this.preparation);
	}
	get canEdit() {
		return (
			this.state.phase === "idle" &&
			!this.state.request &&
			!this.contextError &&
			(!this.fixture || this.state.draft.evidence.kind === "fixture")
		);
	}
	get canConfirm() {
		const { draft, request, phase, body } = this.state;
		return (
			!this.fixture &&
			!this.contextError &&
			!this.dirty &&
			body.trim().length > 0 &&
			(phase === "idle" || phase === "uncertain") &&
			(!request ||
				(request.draftId === draft.id &&
					request.draftRevision === draft.revision &&
					request.headSha === draft.headSha &&
					request.body === draft.body))
		);
	}
	get confirmed() {
		return this.canConfirm && this.state.consent === confirmationIdentity(this.state.draft);
	}

	setBody(body: string) {
		if (!this.canEdit) return;
		this.update({ body, consent: null, error: "", notice: "" });
	}
	setConsent(checked: boolean) {
		this.update({
			consent: checked && this.canConfirm ? confirmationIdentity(this.state.draft) : null,
		});
	}

	async save(adapter: DraftAdapter | null): Promise<DraftedComment | null> {
		if (!this.canEdit || !this.dirty || !this.state.body.trim()) return null;
		const { draft, body } = this.state;
		// A fixture review never sends edits to a real adapter either.
		if (this.fixture && draft.evidence.kind !== "fixture") return null;
		if (!this.fixture && !adapter) return null;
		const generation = this.generation;
		this.update({ phase: "saving", consent: null, error: "", notice: "" });
		try {
			const result = DraftedCommentSchema.parse(
				this.fixture
					? { ...draft, body, revision: draft.revision + 1 }
					: await adapter?.edit(draft.id, body)
			);
			if (generation !== this.generation) return null;
			if (
				result.id !== draft.id ||
				result.prId !== draft.prId ||
				result.headSha !== draft.headSha ||
				result.revision <= draft.revision ||
				result.originalWords !== draft.originalWords ||
				JSON.stringify(result.location) !== JSON.stringify(draft.location) ||
				result.evidence.kind !== draft.evidence.kind ||
				draftContextError(result, this.preparation)
			)
				throw new Error("Invalid draft edit response");
			this.update({
				draft: result,
				body: result.body,
				notice: this.fixture
					? "Fixture edit saved locally. Nothing was posted."
					: "Changes saved. Review the returned draft and confirm this revision before posting.",
			});
			return result;
		} catch {
			if (generation === this.generation)
				this.update({
					error: "Could not save this draft. Your edits are still here; try saving again.",
				});
			return null;
		} finally {
			this.update({ phase: "idle" });
		}
	}

	async post(adapter: DraftAdapter | null): Promise<void> {
		if (!adapter || !this.confirmed) return;
		const { draft } = this.state;
		let request: ConfirmCommentInput;
		try {
			request =
				this.state.request ??
				ConfirmCommentInputSchema.parse({
					requestId: this.requestId(),
					draftId: draft.id,
					draftRevision: draft.revision,
					headSha: this.preparation.pr.headSha,
					body: draft.body,
					confirmed: true,
				});
		} catch {
			this.update({ consent: null, error: "Could not prepare confirmation. Nothing was sent." });
			return;
		}
		// Set the lock before awaiting: repeated clicks cannot enter confirm twice.
		this.update({ request, phase: "posting", consent: null, error: "", notice: "" });
		const prUrl = this.preparation.pr.url;
		try {
			const result = await adapter.confirm({ ...request });
			const url = new URL(result.url);
			const pr = new URL(prUrl);
			if (
				url.protocol !== "https:" ||
				url.origin !== pr.origin ||
				url.pathname !== pr.pathname ||
				url.username ||
				url.password
			)
				throw new Error("Invalid comment URL");
			this.update({
				phase: "posted",
				url: url.href,
				notice: `Comment revision ${request.draftRevision} posted to GitHub at head ${request.headSha.slice(0, 7)}.`,
			});
		} catch {
			// The adapter does not distinguish preflight rejection from an ambiguous write.
			// Keep this request, lock edits, and require a fresh checkbox + explicit retry.
			this.update({
				phase: "uncertain",
				error:
					"Posting could not be confirmed. The comment may already exist. Check GitHub before explicitly retrying the same request. Edits are locked until the outcome is resolved.",
			});
		}
	}
}

// Session memory intentionally survives artifact switches/remounts. Never restore consent.
// Main must persist posting outcomes across renderer/application restarts.
const sessions = new Map<string, SignoffDraftSession>();
export function signoffSession(draft: DraftedComment, preparation: PRPreparation) {
	const key = JSON.stringify([preparation.pr.repository, draft.prId, draft.id]);
	let session = sessions.get(key);
	if (!session) {
		session = new SignoffDraftSession(draft, preparation);
		sessions.set(key, session);
	}
	return session;
}
