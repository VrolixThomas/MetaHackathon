import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { RepositorySchema } from "./access";
import { TeamError, sha256 } from "./protocol";
import { type SupabaseRest, query } from "./supabase";

export const WebhookPayloadSchema = z.object({
	action: z.enum(["opened", "reopened", "synchronize", "edited", "ready_for_review"]),
	number: z.int().positive(),
	repository: z.object({ id: z.number().int().positive() }),
	installation: z.object({ id: z.number().int().positive() }),
});
export async function receiveWebhook(
	request: Request,
	options: { secret: string; db: SupabaseRest }
): Promise<Response> {
	try {
		if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
		const reader = request.body?.getReader();
		if (!reader) throw new TeamError("invalid");
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 1000000) throw new TeamError("invalid");
				chunks.push(value);
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		const raw = Buffer.concat(chunks);
		const signature = request.headers.get("x-hub-signature-256") ?? "";
		if (
			!/^sha256=[0-9a-f]{64}$/.test(signature) ||
			!options.secret ||
			!timingSafeEqual(
				Buffer.from(signature.slice(7), "hex"),
				createHmac("sha256", options.secret).update(raw).digest()
			)
		)
			throw new TeamError("unauthorized");
		if (request.headers.get("x-github-event") !== "pull_request")
			return Response.json({ status: "ignored" }, { status: 202 });
		const parsed = WebhookPayloadSchema.safeParse(JSON.parse(raw.toString("utf8")));
		if (!parsed.success) return Response.json({ status: "ignored" }, { status: 202 });
		const payload = parsed.data;
		const delivery = z.uuid().parse(request.headers.get("x-github-delivery"));
		const repositories = z
			.array(RepositorySchema)
			.max(100)
			.parse(
				await options.db.request(
					query("team_repositories", {
						repository_id: String(payload.repository.id),
						installation_id: String(payload.installation.id),
						enabled: "true",
					})
				)
			);
		if (repositories.length === 0) throw new TeamError("forbidden");
		// One installation/repo can serve several verified Muse orgs. Delivery identity includes org scope.
		for (const repository of repositories) {
			await options.db.rpc("team_ingest_webhook", {
				p_delivery: scopedDelivery(delivery, repository.org_id),
				p_digest: sha256(raw.toString("utf8")),
				p_org: repository.org_id,
				p_repository: repository.repository_id,
				p_installation: repository.installation_id,
				p_payload: payload,
			});
		}
		return Response.json({ status: "queued" }, { status: 202 });
	} catch (error) {
		const code = error instanceof TeamError ? error.code : "invalid";
		return Response.json(
			{ error: code },
			{
				status:
					code === "unauthorized"
						? 401
						: code === "forbidden"
							? 403
							: code === "conflict"
								? 409
								: code === "offline" || code === "unavailable"
									? 503
									: 400,
			}
		);
	}
}
/** UUID with deterministic bytes; no random identity on webhook retries. */
export function scopedDelivery(delivery: string, org: string) {
	const hex = sha256(`${delivery}:${org}`);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
