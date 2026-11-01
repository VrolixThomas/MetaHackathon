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
export type StoryState = {
	chapter: ChapterId;
	planScope: "position" | "layout" | null;
	file: number;
	discussion: boolean;
	flow: "flow" | "run" | "visual";
	proposal: "before" | "after";
	follow: "notify" | "approve";
	clarified: boolean;
	paused: boolean;
};
export const initialStory: StoryState = {
	chapter: "plan",
	planScope: null,
	file: 0,
	discussion: false,
	flow: "flow",
	proposal: "after",
	follow: "notify",
	clarified: false,
	paused: false,
};
export type StoryAction =
	| { type: "chapter"; chapter: ChapterId }
	| { type: "next" }
	| { type: "scope"; scope: NonNullable<StoryState["planScope"]> }
	| { type: "file"; file: number }
	| { type: "discussion"; open: boolean }
	| { type: "flow"; view: StoryState["flow"] }
	| { type: "proposal"; view: StoryState["proposal"] }
	| { type: "follow"; mode: StoryState["follow"] }
	| { type: "clarify" }
	| { type: "motion" };

export function storyReducer(state: StoryState, action: StoryAction): StoryState {
	switch (action.type) {
		case "chapter":
			return chapters.some((c) => c.id === action.chapter)
				? { ...state, chapter: action.chapter, discussion: false }
				: state;
		case "next":
			return {
				...state,
				chapter:
					chapters[(chapters.findIndex((c) => c.id === state.chapter) + 1) % chapters.length]?.id ??
					"plan",
				discussion: false,
			};
		case "scope":
			return { ...state, planScope: action.scope };
		case "file":
			return Number.isInteger(action.file) && action.file >= 0 && action.file < reviewFiles.length
				? { ...state, file: action.file, discussion: false }
				: state;
		case "discussion":
			return { ...state, discussion: action.open };
		case "flow":
			return { ...state, flow: action.view };
		case "proposal":
			return { ...state, proposal: action.view };
		case "follow":
			return { ...state, follow: action.mode };
		case "clarify":
			return { ...state, clarified: !state.clarified };
		case "motion":
			return { ...state, paused: !state.paused };
	}
}

export const reviewFiles = [
	{
		path: "src/routes/review.ts",
		label: "Receive the request",
		why: "Start at the entry point. This route passes the selected review to preparation.",
		code: [
			"export async function resumeReview(input) {",
			"  const plan = await prepareReview(input);",
			"  return openAtCheckpoint(plan);",
			"}",
		],
	},
	{
		path: "src/review/prepare.ts",
		label: "Prepare the review",
		why: "Follow the call into preparation. The saved checkpoint determines where the review starts.",
		code: [
			"export async function prepareReview(input) {",
			"  const checkpoint = await store.read(input.id);",
			"  return { ...input, checkpoint };",
			"}",
		],
	},
	{
		path: "src/db/review-store.ts",
		label: "Save its progress",
		why: "Finish at persistence. The checkpoint needs the source revision as well as the file position.",
		code: [
			"export async function saveCheckpoint(input) {",
			"  await database.save({",
			"    review: input.id, file: input.file,",
			"    head: input.head, position: input.position,",
			"  });",
			"}",
		],
	},
] as const;

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
			"Voice is available throughout the workspace, and typing is available when you prefer it. The website walkthrough is a scripted illustration; its controls do not access your microphone or connect to your accounts.",
	},
	{
		question: "Where does background work run?",
		answer:
			"The current app runs coding jobs in separate workspaces on your Mac. Your Mac needs to stay awake and connected for that work and its follow-ups. Hosted always-on execution is not part of this version.",
	},
	{
		question: "Can I download it yet?",
		answer:
			"MuseFocus is in development. Explore the walkthrough here; a verified public release and the finished demo video will be linked when they are ready.",
	},
] as const;
