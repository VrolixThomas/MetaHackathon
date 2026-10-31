import { createHash } from "node:crypto";
import { z } from "zod";
import {
	type ConversationTurnInput,
	type GenerateImageInput,
	type ImageAsset,
	ImageAssetSchema,
	type WorkspaceObservation,
	WorkspaceObservationSchema,
} from "../../../shared/contracts";
import { abortable, throwIfAborted } from "../cancellation";
import type { FunctionTool } from "../meta-client";

export interface ConversationImagePorts {
	generate(input: GenerateImageInput, signal: AbortSignal): Promise<ImageAsset>;
	cancel(requestId: string): void;
}
const argumentsSchema = z.strictObject({
	title: z.string().trim().min(1).max(120),
	prompt: z.string().trim().min(1).max(12000),
	target: z.enum(["primary", "secondary"]).optional(),
});
/** Main generation plus the existing workspace receipt gate; no data URLs or paths enter the model. */
export class ConversationImageTools {
	private sequence = 0;
	constructor(
		private readonly ports: ConversationImagePorts,
		private readonly turn: ConversationTurnInput,
		private readonly signal: AbortSignal,
		private readonly show: (
			assetId: string,
			target?: "primary" | "secondary"
		) => Promise<WorkspaceObservation>
	) {}
	get tools(): FunctionTool[] {
		return [
			{
				type: "function",
				name: "generate_raster_image",
				description:
					"Generate a real provider raster image privately and display it in the workspace. Use for photos, paintings and raster illustrations; typed visual mocks remain separate. Requires configured image-provider credentials; errors do not block other tools. No fixture success, remote image fetch, screenshot or PR execution claim. Waits for actual image decode and workspace display acknowledgement.",
				parameters: z.toJSONSchema(argumentsSchema),
			},
		];
	}
	has(name: string) {
		return name === "generate_raster_image";
	}
	async execute(name: string, rawArguments: string) {
		if (!this.has(name)) throw new Error("That image operation is unavailable.");
		const args = argumentsSchema.parse(JSON.parse(rawArguments));
		throwIfAborted(this.signal);
		const requestId = `image-op-${createHash("sha256")
			.update(
				JSON.stringify([
					this.turn.sessionId,
					this.turn.turnId,
					this.turn.generation,
					this.turn.requestId,
					++this.sequence,
				])
			)
			.digest("hex")}`;
		const cancel = () => this.ports.cancel(requestId);
		this.signal.addEventListener("abort", cancel, { once: true });
		try {
			throwIfAborted(this.signal);
			const asset = ImageAssetSchema.parse(
				await abortable(
					this.ports.generate({ requestId, title: args.title, prompt: args.prompt }, this.signal),
					this.signal
				)
			);
			throwIfAborted(this.signal);
			const observation = WorkspaceObservationSchema.parse(
				await abortable(this.show(asset.id, args.target), this.signal)
			);
			const shown = observation.workspace.canvases.some(
				(canvas) =>
					canvas.kind === "image" &&
					(canvas.id === observation.workspace.primaryId ||
						canvas.id === observation.workspace.secondaryId) &&
					JSON.stringify(canvas.asset) === JSON.stringify(asset)
			);
			if (!shown)
				throw new Error(
					"The generated image was saved privately but was not acknowledged as displayed."
				);
			return {
				asset,
				displayed: true,
				workspace: observation.workspace,
				policy:
					"Provider-generated raster artifact. No screenshot, source intent or execution evidence.",
			};
		} finally {
			this.signal.removeEventListener("abort", cancel);
		}
	}
}
