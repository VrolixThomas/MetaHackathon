export const chapters = [
	{
		id: "plan",
		label: "Plan your day",
		source: "Linear",
		title: "Start with the right questions.",
		subtitle: "A rough ticket becomes a useful first pass when the missing decisions are clear.",
		cue: "“What do we need to know before you start?”",
	},
	{
		id: "review",
		label: "Review in context",
		source: "GitHub",
		title: "Follow the change. Keep the context.",
		subtitle:
			"Start at the entry point and follow the code through the change, with the ticket close by.",
		cue: "“Walk me through this review.”",
	},
	{
		id: "flow",
		label: "Zoom out",
		source: "Workspace",
		title: "See the whole thing, in focus.",
		subtitle:
			"Move between the code, the bigger flow and a conversation without rebuilding the context.",
		cue: "“Show me the entire flow.”",
	},
	{
		id: "fix",
		label: "Propose a fix",
		source: "GitHub",
		title: "Leave more than a comment.",
		subtitle:
			"Turn a concrete suggestion into a proposed change the author can inspect and decide on.",
		cue: "“Can you prepare a fix for the author?”",
	},
	{
		id: "follow",
		label: "Leave instructions",
		source: "Follow-up",
		title: "Keep the conditions. Drop the checking.",
		subtitle:
			"Leave explicit follow-up instructions, then return when the work needs your judgment.",
		cue: "“Bring this back when my attention is needed.”",
	},
	{
		id: "clarify",
		label: "Keep your focus",
		source: "Slack",
		title: "Less relaying. More understanding.",
		subtitle:
			"With your permission, missing context becomes a bounded conversation in the original thread.",
		cue: "“Ask what they were trying to do.”",
	},
] as const;

export type ChapterId = (typeof chapters)[number]["id"];
export type StoryState = { chapter: ChapterId; paused: boolean };
export const initialStory: StoryState = { chapter: "plan", paused: false };
export type StoryAction =
	| { type: "chapter"; chapter: ChapterId }
	| { type: "next" }
	| { type: "motion" };
export function storyReducer(state: StoryState, action: StoryAction): StoryState {
	switch (action.type) {
		case "chapter":
			return { ...state, chapter: action.chapter };
		case "next":
			return {
				...state,
				chapter:
					chapters[(chapters.findIndex((c) => c.id === state.chapter) + 1) % chapters.length]?.id ??
					"plan",
			};
		case "motion":
			return { ...state, paused: !state.paused };
	}
}

export const questions = [
	{
		question: "What is MuseFocus?",
		answer:
			"A voice-first workspace that connects your work in GitHub, Linear and Slack. You can plan tickets, guide independent coding work, review changes in context and keep follow-ups in view through one ongoing conversation.",
	},
	{
		question: "Does MuseFocus approve or send things on its own?",
		answer:
			"Only within a scope you explicitly authorize. Conditional PR approval and Slack clarification have their own permissions and boundaries. A ready change is not a merge, a draft is not a sent message, and you can pause or revoke a delegation.",
	},
	{
		question: "Do I need to use voice?",
		answer:
			"Voice is available throughout the workspace, and typing is available when you prefer it. The website shows captures from the actual desktop app using prepared demo data; its controls select screenshots and do not access your microphone or accounts.",
	},
	{
		question: "Where does background work run?",
		answer:
			"The current app runs coding jobs in separate workspaces on your Mac. Your Mac needs to stay awake and connected for that work and its follow-ups. Hosted always-on execution is not part of this version.",
	},
	{
		question: "Where can I get the latest version?",
		answer:
			"The download section links to the macOS installers attached to the latest public release on GitHub. If an installer is not available yet, you can follow the public repository and check its releases. New releases appear here automatically.",
	},
] as const;
