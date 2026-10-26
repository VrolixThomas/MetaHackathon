import { create } from "zustand";
import {
	type CodeLocation,
	CodeLocationSchema,
	type DiagramSpec,
	type DraftedComment,
	type PRPreparation,
	PRPreparationSchema,
	type Preview,
	type ScenarioTrace,
	type ScreenContext,
	ScreenContextSchema,
} from "../../shared/contracts";
import type { Artifact, CodeSelection, ReviewFile } from "./model";
import { fixture, initialFiles, orderedFiles, readingRoute } from "./workspace-data";

type ReviewState = {
	sourceMode: "reference" | "repository";
	preparation: PRPreparation;
	scenario: ScenarioTrace | null;
	preview: Preview | null;
	diagram: DiagramSpec | null;
	drafts: DraftedComment[];
	sequence: number;
	scenarioIndex: number;
	scenarioStepId?: string;
	previewMarkerId?: string;
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
	sourceMode: "reference",
	preparation: fixture.preparation,
	scenario: fixture.scenario,
	preview: fixture.preview,
	diagram: fixture.diagram,
	drafts: [fixture.draftComment],
	sequence: 0,
	scenarioIndex: fixture.scenario.divergenceIndex ?? 0,
	files: initialFiles,
	file: initialFiles[0]?.path ?? "pricing/applyDiscounts.ts",
	cursor: 0,
	seen: [],
	why: true,
	panel: null,
	selection: null,
	status: "",
	openFile(file) {
		const index = get().files.findIndex((f) => f.path === file);
		if (index < 0) return;
		set({
			file,
			cursor: readingRoute(get().files).findIndex((f) => f.path === file),
			selection: null,
			sequence: get().sequence + 1,
		});
	},
	moveCursor(delta) {
		set((state) => ({
			cursor: Math.max(0, Math.min(readingRoute(state.files).length - 1, state.cursor + delta)),
		}));
	},
	openCursor() {
		const file = readingRoute(get().files)[get().cursor];
		if (file) get().openFile(file.path);
	},
	navigate(delta) {
		const { file } = get();
		const files = readingRoute(get().files);
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
	setPanel: (panel) => set({ panel, sequence: get().sequence + 1 }),
	setWhy: (why) => set({ why, sequence: get().sequence + 1 }),
	highlight(file, lines, note, side = "after") {
		const target = get().files.find((f) => f.path === file);
		const [start, end] = typeof lines === "number" ? [lines, lines] : lines;
		const numbers = new Set(
			target?.lines.map((line) => (side === "before" ? line.oldLine : line.newLine))
		);
		if (
			!numbers.has(start) ||
			!numbers.has(end) ||
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			start < 1 ||
			start > end
		) {
			set({ status: `Source unavailable: ${file}:${start}-${end}` });
			return false;
		}
		set({
			file,
			cursor: readingRoute(get().files).findIndex((f) => f.path === file),
			selection: { file, start, end, note, side },
			sequence: get().sequence + 1,
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
	openArtifact: openReviewArtifact,
	highlightLocation,
	getScreenContext,
};

export function openReviewArtifact(artifact: Artifact) {
	const state = useReview.getState();
	state.setPanel(artifact);
	if (artifact === "scenario" && state.scenario) {
		const step = state.scenario.after.steps[state.scenarioIndex];
		if (step) {
			highlightLocation(step.location, `Following scenario C, step ${state.scenarioIndex + 1}`);
			useReview.setState({ scenarioStepId: step.id });
		}
	}
	if (artifact === "preview" && state.preview?.markers[0]) {
		const marker = state.preview.markers[0];
		highlightLocation(marker.location, `Marker ${marker.number}: ${marker.label}`);
		useReview.setState({ previewMarkerId: marker.id });
	}
}

export function highlightLocation(input: CodeLocation, note: string): boolean {
	const parsed = CodeLocationSchema.safeParse(input);
	const state = useReview.getState();
	if (!parsed.success) {
		state.announce("Invalid code location.");
		return false;
	}
	const location = parsed.data;
	const sha =
		location.revision === "base" ? state.preparation.pr.baseSha : state.preparation.pr.headSha;
	if (location.repository !== state.preparation.pr.repository || location.commitSha !== sha) {
		state.announce(
			"This code reference belongs to another repository or revision. Refresh the review."
		);
		return false;
	}
	return state.highlight(
		location.path,
		[location.startLine, location.endLine],
		note,
		location.revision === "base" ? "before" : "after"
	);
}

export function getScreenContext(): ScreenContext {
	const state = useReview.getState();
	const revision = state.selection?.side === "before" ? "base" : "head";
	const file = state.files.find((file) => file.path === state.file);
	const lines =
		file?.lines
			.map((line) => (revision === "base" ? line.oldLine : line.newLine))
			.filter((n): n is number => n !== undefined) ?? [];
	const focusedLocation = lines.length
		? {
				repository: state.preparation.pr.repository,
				revision,
				commitSha:
					revision === "base" ? state.preparation.pr.baseSha : state.preparation.pr.headSha,
				path: state.file,
				startLine: state.selection?.start ?? Math.min(...lines),
				endLine: state.selection?.end ?? Math.max(...lines),
			}
		: null;
	return ScreenContextSchema.parse({
		prId: state.preparation.pr.id,
		sequence: state.sequence,
		panel:
			state.panel === "signoff"
				? "sign-off"
				: state.panel === "conversation" || !state.panel
					? state.why
						? "why"
						: "diff"
					: state.panel,
		focusedLocation,
		...(state.panel === "scenario" && state.scenario
			? { artifactId: state.scenario.id, scenarioStepId: state.scenarioStepId }
			: {}),
		...(state.panel === "preview" && state.preview
			? { artifactId: state.preview.id, previewMarkerId: state.previewMarkerId }
			: {}),
		...(state.panel === "diagram" && state.diagram ? { artifactId: state.diagram.id } : {}),
	});
}

/** Runtime adapter passes source excerpts pinned to the same repository and revisions. */
export function installPreparedReview(
	input: PRPreparation,
	source: { repository: string; baseSha: string; headSha: string; files: ReviewFile[] }
) {
	const preparation = PRPreparationSchema.parse(input);
	if (
		preparation.pr.repository !== source.repository ||
		preparation.pr.baseSha !== source.baseSha ||
		preparation.pr.headSha !== source.headSha
	)
		throw new Error("Source revisions do not match preparation");
	const files = orderedFiles(preparation, source.files);
	useReview.setState((state) => ({
		sourceMode: "repository",
		preparation,
		files,
		file: files[0]?.path ?? "",
		cursor: 0,
		seen: [],
		selection: null,
		sequence: state.sequence + 1,
		scenario: null,
		preview: null,
		diagram: null,
		drafts: [],
		scenarioStepId: undefined,
		previewMarkerId: undefined,
	}));
}
