"use client";
import {
	type ChapterId,
	type StoryAction,
	type StoryState,
	initialStory,
	storyReducer,
} from "@/lib/story";
import { MotionConfig } from "motion/react";
import { type Dispatch, type ReactNode, createContext, useContext, useReducer } from "react";

const StoryContext = createContext<{ state: StoryState; dispatch: Dispatch<StoryAction> } | null>(
	null
);
export function StoryProvider({
	children,
	initialState = initialStory,
}: { children: ReactNode; initialState?: StoryState }) {
	const [state, dispatch] = useReducer(storyReducer, initialState);
	return (
		<StoryContext.Provider value={{ state, dispatch }}>
			<MotionConfig reducedMotion="user">{children}</MotionConfig>
		</StoryContext.Provider>
	);
}
export function useStory() {
	const context = useContext(StoryContext);
	if (!context) throw new Error("Story controls require StoryProvider");
	return context;
}
export function StoryLink({
	chapter,
	children,
	className = "text-link",
}: { chapter: ChapterId; children: ReactNode; className?: string }) {
	const { dispatch } = useStory();
	return (
		<button
			type="button"
			className={className}
			onClick={() => {
				dispatch({ type: "chapter", chapter });
				document.getElementById(`chapter-${chapter}`)?.focus({ preventScroll: true });
				document.getElementById("demo")?.scrollIntoView({ block: "start" });
			}}
		>
			{children}
		</button>
	);
}
