import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { ConversationTurnInput, WorkspaceObservation } from "../../shared/contracts";
import { requestsLocalPreview } from "../agent/preview-intent";
import { executionEnvironment } from "../runtime/environment";
import {
	type LocalPreviewReceipt,
	type LocalPreviewSelection,
	LocalPreviewService,
} from "../runtime/local-preview/service";

const targetSchema = z.strictObject({
	kind: z.enum(["pr", "job"]),
	id: z.string().min(1).max(300),
});
export type PreviewTarget = z.infer<typeof targetSchema>;
export interface PreviewSource {
	selection: LocalPreviewSelection;
	repositoryPath: string;
	account: string;
}
export interface ForegroundPreviewPorts {
	directory: string;
	observe(sessionId: string, signal: AbortSignal): Promise<WorkspaceObservation>;
	resolve(target: PreviewTarget, signal: AbortSignal): Promise<PreviewSource>;
	port?: number;
}
const sameSource = (a: PreviewSource, b: PreviewSource) =>
	a.account === b.account &&
	a.repositoryPath === b.repositoryPath &&
	JSON.stringify(a.selection) === JSON.stringify(b.selection);
export { requestsLocalPreview as explicitPreviewLaunch } from "../agent/preview-intent";

/** A preview outlives its foreground reply; explicit stop, account change and app shutdown own cleanup. */
export class ForegroundLocalPreview {
	private runtime?: LocalPreviewService;
	private source?: PreviewSource;
	private starting = false;
	private closed = false;
	private lifecycle = new AbortController();
	constructor(private readonly ports: ForegroundPreviewPorts) {}
	inspect() {
		return this.runtime?.inspect()?.receipt ?? null;
	}
	async start(
		raw: PreviewTarget,
		turn: ConversationTurnInput,
		caller: AbortSignal
	): Promise<LocalPreviewReceipt> {
		const target = targetSchema.parse(raw);
		if (this.closed || this.starting)
			throw new Error("Local preview is unavailable or already starting");
		if (!requestsLocalPreview(turn.text))
			throw new Error("Ask explicitly to run the selected code locally before starting a preview");
		const signal = AbortSignal.any([caller, this.lifecycle.signal]);
		signal.throwIfAborted();
		this.starting = true;
		let launching: LocalPreviewService | undefined;
		const launchAbort = new AbortController();
		const abort = () => launchAbort.abort();
		signal.addEventListener("abort", abort, { once: true });
		try {
			const observed = await this.ports.observe(turn.sessionId, signal);
			const primary = observed.workspace.canvases.find(
				(c) => c.id === observed.workspace.primaryId
			);
			const selected =
				target.kind === "pr"
					? primary?.kind === "review" && observed.workspace.review.prId === target.id
					: primary?.kind === "center" &&
						["completed", "activity"].includes(primary.section) &&
						primary.selectedId === target.id;
			if (!selected)
				throw new Error("Open the exact PR or completed job before running its preview");
			const source = await this.ports.resolve(target, signal);
			signal.throwIfAborted();
			if (
				source.selection.kind !== target.kind ||
				source.selection.sourceId !== target.id ||
				!source.account
			)
				throw new Error("Preview source identity changed");
			const existing = this.runtime?.inspect()?.receipt;
			if (existing?.state === "ready" && this.source && sameSource(source, this.source))
				return existing;
			await this.runtime?.dispose();
			signal.throwIfAborted();
			let npm: string | undefined;
			for (const directory of (executionEnvironment()["PATH"] ?? "").split(delimiter)) {
				if (!isAbsolute(directory)) continue;
				const candidate = join(directory, "npm");
				try {
					await access(candidate, constants.X_OK);
					if ((await stat(candidate)).isFile()) {
						npm = candidate;
						break;
					}
				} catch {}
			}
			if (!npm) throw new Error("npm is unavailable for the local preview");
			signal.throwIfAborted();
			const authorityId = randomUUID();
			launching = new LocalPreviewService({
				directory: join(this.ports.directory, "local-previews"),
				npmExecutable: npm,
				port: this.ports.port ?? 4328,
				authorize: async (request, active) => {
					if (
						request.authorityId !== authorityId ||
						JSON.stringify(request.selection) !== JSON.stringify(source.selection)
					)
						throw new Error("Preview authority does not match its selected revision");
					const current = await this.ports.resolve(target, active);
					if (!sameSource(source, current)) throw new Error("Preview source changed before launch");
					return { repositoryPath: current.repositoryPath };
				},
			});
			this.runtime = launching;
			this.source = source;
			const receipt = await launching.start(
				{ selection: source.selection, authorityId },
				launchAbort.signal
			);
			signal.throwIfAborted();
			if (!sameSource(source, await this.ports.resolve(target, signal)))
				throw new Error("Preview source changed during startup");
			signal.throwIfAborted();
			return receipt;
		} catch (error) {
			if (launching) await launching.dispose();
			throw error;
		} finally {
			signal.removeEventListener("abort", abort);
			this.starting = false;
		}
	}
	async stop(runId: string) {
		if (this.inspect()?.runId === runId) await this.runtime?.stop();
	}
	async invalidate() {
		this.lifecycle.abort();
		this.lifecycle = new AbortController();
		await this.runtime?.stop();
		this.source = undefined;
	}
	async dispose() {
		this.closed = true;
		this.lifecycle.abort();
		await this.runtime?.dispose();
	}
}
