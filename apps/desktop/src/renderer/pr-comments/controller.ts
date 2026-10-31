import {
	type ConfirmCommentInput,
	ConfirmCommentInputSchema,
	type DraftedComment,
	DraftedCommentSchema,
	type PullRequest,
} from "../../shared/contracts";
import type { PRCommentApi } from "./api";
import { type PRCommentContext, commentContextKey, commentLocation } from "./context";

export type PRCommentState = {
	open: boolean;
	context: PRCommentContext | null;
	body: string;
	line: string;
	draft: DraftedComment | null;
	draftPr: PullRequest | null;
	consent: boolean;
	phase: "compose" | "saving" | "review" | "posting" | "uncertain" | "posted";
	request: ConfirmCommentInput | null;
	url: string | null;
	error: string;
	notice: string;
};

/** Lives above the dialog so closing/reopening never creates a second posting attempt. */
export function createPRCommentController(
	api: PRCommentApi,
	readContext: () => PRCommentContext | null,
	requestId: () => string = () => crypto.randomUUID()
) {
	let state: PRCommentState = {
		open: false,
		context: readContext(),
		body: "",
		line: "",
		draft: null,
		draftPr: null,
		consent: false,
		phase: "compose",
		request: null,
		url: null,
		error: "",
		notice: "",
	};
	let generation = 0;
	let disposed = false;
	let confirmationPending = false;
	const listeners = new Set<() => void>();
	const update = (patch: Partial<PRCommentState>) => {
		state = { ...state, ...patch };
		for (const listener of listeners) listener();
	};
	const cancelPending = () => {
		const request = state.request;
		if (!request || state.phase !== "posting") return;
		update({
			phase: "uncertain",
			consent: false,
			notice:
				"Cancellation requested. The comment may already have been sent. Check GitHub before retrying this request.",
		});
		void api.cancel(request.requestId).catch(() => {
			if (state.request?.requestId !== request.requestId || state.phase === "posted") return;
			update({ error: "Could not confirm cancellation. Check GitHub for the original comment." });
		});
	};
	const refreshContext = () => {
		const context = readContext();
		if (commentContextKey(context) === commentContextKey(state.context)) return;
		generation++;
		cancelPending();
		update({
			context,
			consent: false,
			...(!state.request
				? {
						draft: null,
						draftPr: null,
						phase: "compose" as const,
						line: context?.selectedLine?.toString() ?? "",
						error: "",
						notice: "The review target changed. Review your comment again before posting.",
					}
				: {}),
		});
	};
	const sameDraftContext = () => {
		const { draft, context } = state;
		return (
			!!draft &&
			!!context &&
			draft.prId === context.pr.id &&
			draft.headSha === context.pr.headSha &&
			(!draft.location ||
				(draft.location.repository === context.pr.repository &&
					draft.location.path === context.file.path &&
					draft.location.revision === "head" &&
					draft.location.commitSha === context.pr.headSha))
		);
	};
	const canConfirm = () =>
		!disposed &&
		state.open &&
		!confirmationPending &&
		sameDraftContext() &&
		state.body === state.draft?.body &&
		(state.phase === "review" || state.phase === "uncertain") &&
		(!state.request ||
			(state.request.draftId === state.draft?.id &&
				state.request.draftRevision === state.draft?.revision &&
				state.request.body === state.draft?.body &&
				state.request.headSha === state.draft?.headSha));
	const open = () => {
		if (disposed) return;
		refreshContext();
		if (!state.context && !state.request) return;
		update({
			open: true,
			consent: false,
			...(!state.draft && !state.request
				? {
						line: state.context?.selectedLine?.toString() ?? "",
					}
				: {}),
		});
	};
	const close = () => {
		generation++;
		cancelPending();
		update({
			open: false,
			consent: false,
			...(state.phase === "saving"
				? { phase: "compose" as const, draft: null, draftPr: null }
				: {}),
		});
	};
	const setBody = (body: string) => {
		refreshContext();
		if (disposed || state.request || state.phase !== "compose") return;
		update({ body, consent: false, error: "" });
	};
	const setLine = (line: string) => {
		refreshContext();
		if (disposed || state.request || state.phase !== "compose") return;
		// Changing an anchor requires a new draft; edits only change body in the existing API.
		update({ line, draft: null, draftPr: null, consent: false, error: "" });
	};
	const edit = () => {
		refreshContext();
		if (!disposed && !state.request && state.phase === "review")
			update({ phase: "compose", consent: false });
	};
	const review = async () => {
		refreshContext();
		if (disposed || !state.open || state.request || state.phase !== "compose" || !state.context)
			return;
		const { context, body, draft } = state;
		if (!body.trim() || body.length > 20000) {
			update({ error: "Enter a comment between 1 and 20,000 characters." });
			return;
		}
		const current = ++generation;
		let location: DraftedComment["location"];
		try {
			location = commentLocation(context, state.line);
		} catch {
			update({
				error:
					"Choose a head-side line present in this file's diff, or leave the line blank for a general PR comment.",
			});
			return;
		}
		try {
			update({ phase: "saving", consent: false, error: "", notice: "" });
			const saved = DraftedCommentSchema.parse(
				draft
					? draft.body === body
						? draft
						: await api.edit(draft.id, body)
					: await api.create({
							requestId: requestId(),
							prId: context.pr.id,
							reviewId: context.reviewId,
							headSha: context.pr.headSha,
							body,
							...(location ? { location } : {}),
						})
			);
			refreshContext();
			if (disposed || current !== generation) return;
			if (
				saved.prId !== context.pr.id ||
				saved.headSha !== context.pr.headSha ||
				saved.body !== body ||
				saved.evidence.kind === "fixture" ||
				JSON.stringify(saved.location) !== JSON.stringify(location) ||
				(draft
					? saved.id !== draft.id ||
						saved.revision < draft.revision ||
						(saved.body !== draft.body && saved.revision <= draft.revision) ||
						saved.originalWords !== draft.originalWords ||
						JSON.stringify(saved.evidence) !== JSON.stringify(draft.evidence)
					: saved.originalWords !== body)
			)
				throw new Error("Draft response mismatch");
			update({ draft: saved, draftPr: context.pr, phase: "review" });
		} catch {
			if (!disposed && current === generation)
				update({
					phase: "compose",
					consent: false,
					error:
						"Could not prepare this exact comment at the selected PR head. Your text is retained; refresh the review or try again.",
				});
		}
	};
	const setConsent = (checked: boolean) => {
		refreshContext();
		update({ consent: checked && canConfirm() });
	};
	const post = async () => {
		refreshContext();
		if (!state.open || !state.consent || !canConfirm() || !state.draft || !state.context) return;
		const draft = state.draft;
		const prUrl = state.context.pr.url;
		const request =
			state.request ??
			ConfirmCommentInputSchema.parse({
				requestId: requestId(),
				draftId: draft.id,
				draftRevision: draft.revision,
				headSha: draft.headSha,
				body: draft.body,
				confirmed: true,
			});
		// Lock synchronously before IPC. A retry always retains this exact request ID and body.
		confirmationPending = true;
		update({ request, phase: "posting", consent: false, error: "", notice: "" });
		try {
			const result = await api.confirm({ ...request });
			if (state.request?.requestId !== request.requestId) return;
			const url = new URL(result.url);
			const pr = new URL(prUrl);
			if (
				url.protocol !== "https:" ||
				url.origin !== pr.origin ||
				url.pathname !== pr.pathname ||
				url.username ||
				url.password ||
				!url.hash
			)
				throw new Error("Invalid comment receipt");
			update({ phase: "posted", url: url.href, notice: "Comment posted to GitHub." });
		} catch {
			if (state.request?.requestId !== request.requestId || state.phase === "posted") return;
			update({
				phase: "uncertain",
				consent: false,
				error:
					"Posting was not confirmed. The PR may have changed, or the comment may already exist. Check GitHub before retrying the same request. Edits are locked for this attempt.",
			});
		} finally {
			confirmationPending = false;
			update({});
		}
	};
	const newComment = () => {
		refreshContext();
		if (disposed || state.phase !== "posted" || !state.url || !state.context) return;
		generation++;
		update({
			body: "",
			line: state.context.selectedLine?.toString() ?? "",
			draft: null,
			draftPr: null,
			consent: false,
			phase: "compose",
			request: null,
			url: null,
			error: "",
			notice: "",
		});
	};
	/** Adopt the main service's canonical draft; never call create/edit or infer consent here. */
	const adoptDraft = (raw: DraftedComment, reviewId: string) => {
		refreshContext();
		const draft = DraftedCommentSchema.parse(raw);
		const context = state.context;
		if (
			disposed ||
			!context ||
			context.reviewId !== reviewId ||
			state.request ||
			confirmationPending ||
			state.phase === "saving" ||
			draft.evidence.kind === "fixture" ||
			draft.body.length > 20000 ||
			draft.prId !== context.pr.id ||
			draft.headSha !== context.pr.headSha ||
			(draft.location &&
				(draft.location.path !== context.file.path ||
					draft.location.repository !== context.pr.repository ||
					draft.location.revision !== "head" ||
					draft.location.commitSha !== context.pr.headSha ||
					draft.location.startLine !== draft.location.endLine))
		)
			return false;
		if (state.draft && (state.draft.id !== draft.id || state.draft.revision > draft.revision))
			return false;
		if (
			state.draft?.revision === draft.revision &&
			JSON.stringify(state.draft) !== JSON.stringify(draft)
		)
			return false;
		if (
			state.phase === "compose" &&
			state.body &&
			state.body !== state.draft?.body &&
			state.body !== draft.body
		)
			return false;
		generation++;
		update({
			open: true,
			draft: structuredClone(draft),
			draftPr: context.pr,
			body: draft.body,
			line: draft.location?.endLine.toString() ?? "",
			phase: "review",
			consent: false,
			error: "",
			notice: "Review this exact comment before confirming.",
		});
		return true;
	};
	/** Mirror a trusted main-owned voice attempt without issuing another confirmation RPC. */
	const adoptConfirmation = (raw: ConfirmCommentInput) => {
		refreshContext();
		const input = ConfirmCommentInputSchema.parse(raw);
		const draft = state.draft;
		if (
			disposed ||
			!draft ||
			!sameDraftContext() ||
			state.body !== draft.body ||
			input.draftId !== draft.id ||
			input.draftRevision !== draft.revision ||
			input.body !== draft.body ||
			input.headSha !== draft.headSha
		)
			return false;
		if (state.request) return JSON.stringify(state.request) === JSON.stringify(input);
		generation++;
		update({ request: input, phase: "posting", consent: false, error: "", notice: "" });
		return true;
	};
	const settleConfirmation = (requestId: string, result: { url: string } | null) => {
		if (disposed || state.request?.requestId !== requestId) return false;
		if (state.phase === "posted") return true;
		try {
			if (!result || !state.draftPr) throw new Error("Unconfirmed comment");
			const url = new URL(result.url);
			const pr = new URL(state.draftPr.url);
			if (
				url.protocol !== "https:" ||
				url.origin !== pr.origin ||
				url.pathname !== pr.pathname ||
				url.username ||
				url.password ||
				url.search ||
				!/^#(?:issuecomment-\d+|discussion_r\d+)$/.test(url.hash)
			)
				throw new Error("Invalid comment receipt");
			update({
				phase: "posted",
				consent: false,
				url: url.href,
				notice: "Comment posted to GitHub.",
				error: "",
			});
		} catch {
			update({
				phase: "uncertain",
				consent: false,
				error:
					"Posting was not confirmed. Check GitHub before retrying the same request. Edits are locked for this attempt.",
			});
		}
		return true;
	};
	return {
		getSnapshot: () => state,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		refreshContext,
		open,
		close,
		setBody,
		setLine,
		edit,
		review,
		setConsent,
		post,
		canConfirm,
		newComment,
		adoptDraft,
		adoptConfirmation,
		settleConfirmation,
		dispose: () => {
			disposed = true;
			generation++;
			cancelPending();
			listeners.clear();
		},
	};
}
export type PRCommentController = ReturnType<typeof createPRCommentController>;
