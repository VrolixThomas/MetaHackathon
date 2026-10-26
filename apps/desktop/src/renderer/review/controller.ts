import { create } from "zustand";
import type { Artifact, CodeSelection, ReviewFile } from "./model";
import { referenceFiles } from "./reference-diff";

type ReviewState = {
	files: ReviewFile[];
	file: string;
	cursor: number;
	seen: string[];
	why: boolean;
	panel: Artifact | null;
	selection: CodeSelection | null;
	status: string;
	openFile: (file: string) => void;
	moveCursor: (delta: number) => void;
	openCursor: () => void;
	navigate: (delta: number) => void;
	markSeen: () => void;
	setPanel: (panel: Artifact | null) => void;
	setWhy: (why: boolean) => void;
	highlight: (
		file: string,
		lines: number | [number, number],
		note: string,
		side?: "before" | "after"
	) => boolean;
	announce: (status: string) => void;
};

export const useReview = create<ReviewState>((set, get) => ({
	files: referenceFiles,
	file: referenceFiles[0]?.path ?? "pricing/applyDiscounts.ts",
	cursor: 0,
	seen: [],
	why: true,
	panel: null,
	selection: null,
	status: "",
	openFile(file) {
		const index = get().files.findIndex((f) => f.path === file);
		if (index < 0) return;
		set({ file, cursor: index, selection: null });
	},
	moveCursor(delta) {
		set((state) => ({
			cursor: Math.max(0, Math.min(state.files.length - 1, state.cursor + delta)),
		}));
	},
	openCursor() {
		const file = get().files[get().cursor];
		if (file) get().openFile(file.path);
	},
	navigate(delta) {
		const { files, file } = get();
		const target =
			files[
				Math.max(0, Math.min(files.length - 1, files.findIndex((f) => f.path === file) + delta))
			];
		if (target) get().openFile(target.path);
	},
	markSeen() {
		set((state) => ({
			seen: state.seen.includes(state.file)
				? state.seen.filter((f) => f !== state.file)
				: [...state.seen, state.file],
		}));
	},
	setPanel: (panel) => set({ panel }),
	setWhy: (why) => set({ why }),
	highlight(file, lines, note, side = "after") {
		const target = get().files.find((f) => f.path === file);
		const [start, end] = typeof lines === "number" ? [lines, lines] : lines;
		const exists = target?.lines.some((line) => {
			const n = side === "before" ? line.oldLine : line.newLine;
			return n !== undefined && n >= start && n <= end;
		});
		if (!exists || start < 1 || start > end) {
			set({ status: `Source unavailable: ${file}:${start}-${end}` });
			return false;
		}
		set({
			file,
			cursor: get().files.findIndex((f) => f.path === file),
			selection: { file, start, end, note, side },
			status: note,
		});
		return true;
	},
	announce: (status) => set({ status }),
}));

/** Renderer-facing API consumed by artifacts and the integration adapter. */
export const reviewController = {
	highlight: (
		file: string,
		lines: number | [number, number],
		note: string,
		side?: "before" | "after"
	) => useReview.getState().highlight(file, lines, note, side),
	openArtifact: (artifact: Artifact) => useReview.getState().setPanel(artifact),
	getScreenContext: () => {
		const { file, selection, panel } = useReview.getState();
		return { file, selection, artifact: panel };
	},
};
