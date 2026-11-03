/** Fixed categories only: never emit message, arbitrary class names, paths or stack text. */
export function conversationErrorDiagnostic(error: unknown) {
	const classes = [
		"Error",
		"TypeError",
		"RangeError",
		"ReferenceError",
		"SyntaxError",
		"ZodError",
		"MetaApiError",
		"GuidedReviewError",
		"WorkspaceArgumentError",
		"ReplyError",
		"ContextError",
		"WorkspaceError",
		"WorkAdmissionError",
		"AbortError",
		"TimeoutError",
		"HubFailure",
		"PRFixError",
		"TeamToolError",
		"TeamError",
	] as const;
	const frames = [
		"runGuidedReview",
		"runWorkspaceConversation",
		"runWorkspace",
		"runReview",
		"WorkspaceCoordinator.execute",
		"WorkspaceCoordinator.observe",
		"ConversationWorkspaceTools.execute",
		"ConversationWorkspaceTools.observe",
		"ConversationHubTools.observe",
		"ConversationHubTools.execute",
		"CommandCenter.source",
		"CommandCenter.search",
		"resolvePinnedSource",
		"ConversationHubTools.currentContext",
		"ForegroundProfile.select",
		"workspaceModelContext",
		"hubModelContext",
	] as const;
	const name = error instanceof Error ? error.name : "";
	const constructorName = error instanceof Error ? error.constructor.name : "";
	// Only anchored stack frames participate; the first line (the message) is excluded.
	const stack =
		error instanceof Error && typeof error.stack === "string"
			? error.stack.split("\n").slice(1)
			: [];
	const sourceCode =
		error instanceof Error && "kind" in error
			? error.kind
			: error instanceof Error && "code" in error
				? error.code
				: undefined;
	const knownSourceCodes = [
		"github",
		"linear",
		"repository",
		"notFound",
		"busy",
		"failed",
		"source",
		"capacity",
		"missing",
		"request",
		"review",
		"interrupted",
		"permission",
		"selection",
		"connection",
		"changed",
		"unknown",
		"unavailable",
		"unauthorized",
		"forbidden",
		"conflict",
		"offline",
	];
	const sourceFailure =
		["HubFailure", "PRFixError", "TeamToolError", "TeamError"].includes(constructorName) &&
		typeof sourceCode === "string" &&
		knownSourceCodes.includes(sourceCode)
			? sourceCode
			: undefined;
	return {
		...(sourceFailure ? { sourceFailure } : {}),
		stage: "conversation-error" as const,
		errorClass:
			classes.find((value) => value === constructorName && value !== "Error") ??
			classes.find((value) => value === name) ??
			"unknown",
		frame:
			stack.flatMap((line) =>
				frames.filter(
					(value) =>
						line.trimStart().startsWith(`at ${value} (`) ||
						line.trimStart().startsWith(`at async ${value} (`)
				)
			)[0] ?? "unknown",
	};
}
