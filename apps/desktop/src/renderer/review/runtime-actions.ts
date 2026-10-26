import { create } from "zustand";
import type { PRPreparation } from "../../shared/contracts";
import { openReviewArtifact, useReview } from "./controller";
import { useServices } from "./services";
import { focusCodeLocation, loadPreparedReview } from "./source-adapter";

export const useRuntimeAction = create<{ busy: boolean; message: string }>(() => ({
	busy: false,
	message: "",
}));
let operation: AbortController | null = null;

async function perform(message: string, action: (signal: AbortSignal) => Promise<void>) {
	if (useRuntimeAction.getState().busy) return;
	const controller = new AbortController();
	operation = controller;
	useRuntimeAction.setState({ busy: true, message });
	try {
		await action(controller.signal);
	} catch (error) {
		if (!controller.signal.aborted)
			useReview
				.getState()
				.announce(
					error instanceof Error && error.message.startsWith("No ")
						? error.message
						: "The local runtime could not complete this action. Check the connection and retry."
				);
	} finally {
		if (operation === controller) {
			operation = null;
			useRuntimeAction.setState({ busy: false, message: "" });
		}
	}
}
export function cancelRuntimeAction() {
	operation?.abort();
}

export function loadLocalDemo() {
	const { runtime, sources } = useServices.getState();
	if (!runtime || !sources) return;
	return perform("Preparing local demo repositories…", async (signal) => {
		const prs = await runtime.prepareDemo();
		signal.throwIfAborted();
		const pr = prs.find((pr) => pr.repository.endsWith("shop-web")) ?? prs[0];
		if (!pr) throw new Error("No seeded demo PR is available.");
		const paths = await runtime.changedFiles(pr.id);
		signal.throwIfAborted();
		const preferred = [
			"pricing/applyDiscounts.ts",
			"orders/finalizeOrder.ts",
			"migrations/0047_order_promo.sql",
			"checkout/PromoField.ts",
			"promo/PromoCache.ts",
		];
		const ordered = [...paths].sort(
			(a, b) =>
				(preferred.indexOf(a) < 0 ? 100 : preferred.indexOf(a)) -
					(preferred.indexOf(b) < 0 ? 100 : preferred.indexOf(b)) || a.localeCompare(b)
		);
		const evidence = {
			kind: "fixture" as const,
			fixtureId: "local-demo-reading-route",
			label:
				"Illustrative preparation for a real seeded repository; no agent triage or Why analysis is claimed.",
		};
		const preparation: PRPreparation = {
			contractVersion: 1,
			pr,
			status: "ready",
			summary:
				"Local seeded demo at pinned Git revisions. Review labels are illustrative; source, scenarios and previews come from the runtime.",
			files: ordered.map((path, readingOrder) => ({
				path,
				readingOrder,
				category: "needs-review",
				attention: "read",
				reason: "Changed source · awaiting agent triage",
				evidence,
			})),
			whyNotes: [],
			evidence,
		};
		await loadPreparedReview(preparation, sources, signal);
		useReview.getState().setPanel(null);
		useReview
			.getState()
			.announce("Loaded pinned local source. No automated review conclusions have been added.");
	});
}

export function runLocalScenario() {
	const runtime = useServices.getState().runtime;
	if (!runtime) return;
	return perform("Running scenario C on both revisions…", async (signal) => {
		const pr = useReview.getState().preparation.pr;
		const trace = await runtime.runScenario(pr.id, "C", signal);
		signal.throwIfAborted();
		const current = useReview.getState().preparation.pr;
		if (
			current.id !== pr.id ||
			current.headSha !== pr.headSha ||
			trace.prId !== pr.id ||
			trace.before.commitSha !== pr.baseSha ||
			trace.after.commitSha !== pr.headSha ||
			trace.before.evidence.kind !== "execution" ||
			trace.after.evidence.kind !== "execution" ||
			[...trace.before.steps, ...trace.after.steps].some(
				(step) => step.location.repository !== pr.repository
			)
		)
			throw new Error("Scenario does not match current source");
		const index = trace.divergenceIndex ?? 0;
		useReview.setState({ scenario: trace, scenarioIndex: index });
		useReview.getState().setPanel("scenario");
		const step = trace.after.steps[index];
		if (step) {
			useReview.setState((state) => ({ scenarioStepId: step.id, sequence: state.sequence + 1 }));
			await focusCodeLocation(step.location, `Executed scenario C · step ${index + 1}`);
		}
	});
}

export function startLocalPreview(mode: "phone" | "desktop" = "phone") {
	const runtime = useServices.getState().runtime;
	if (!runtime) return;
	return perform(`Starting the ${mode} preview…`, async (signal) => {
		const pr = useReview.getState().preparation.pr;
		const previous = useReview.getState().preview;
		if (previous?.evidence.kind === "execution") await runtime.stopPreview(previous.id);
		const preview = await runtime.startPreview(pr.id, mode, signal);
		const current = useReview.getState().preparation.pr;
		if (signal.aborted || current.id !== pr.id || current.headSha !== pr.headSha) {
			await runtime.stopPreview(preview.id);
			return;
		}
		if (
			preview.prId !== pr.id ||
			preview.commitSha !== (preview.revision === "head" ? pr.headSha : pr.baseSha) ||
			preview.evidence.kind !== "execution" ||
			preview.evidence.exitCode !== 0 ||
			preview.markers.some((marker) => marker.location.repository !== pr.repository)
		)
			throw new Error("Preview does not match current source");
		useReview.setState({ preview });
		openReviewArtifact("preview");
		const marker = preview.markers[0];
		if (marker)
			await focusCodeLocation(marker.location, `Marker ${marker.number}: ${marker.label}`);
	});
}
