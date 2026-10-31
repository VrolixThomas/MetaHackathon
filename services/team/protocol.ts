import { createHash } from "node:crypto";
import { ArtifactSchema, type TeamArtifact } from "./schemas";
export * from "./schemas";
/** Sorted keys, preserved string bytes; arrays retain their order. */
export function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
		.join(",")}}`;
}
export function digest(value: unknown): string {
	return sha256(canonical(value));
}
export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
export function artifact(raw: unknown): TeamArtifact {
	const value = ArtifactSchema.parse(raw);
	if (
		value.review.pr.baseSha !== value.key.baseSha ||
		value.review.pr.headSha !== value.key.headSha ||
		value.review.pr.number !== value.key.prNumber ||
		digest({ key: value.key, review: value.review }) !== value.digest
	)
		throw new Error("Team artifact identity or digest mismatch");
	return value;
}
export class TeamError extends Error {
	constructor(
		readonly code:
			| "unauthorized"
			| "forbidden"
			| "offline"
			| "conflict"
			| "invalid"
			| "unavailable",
		readonly status = 0
	) {
		super(`Team service: ${code}`);
	}
}
export function secureUrl(raw: string, local = false): URL {
	const url = new URL(raw);
	if (
		url.pathname !== "/" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.protocol !== "https:" &&
			!(
				local &&
				url.protocol === "http:" &&
				["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
			))
	)
		throw new Error("HTTPS service URL required");
	return url;
}
export async function boundedJson(response: Response, limit = 4_000_000): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new TeamError("invalid");
	const chunks: Uint8Array[] = [];
	let count = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			count += value.byteLength;
			if (count > limit) throw new TeamError("invalid");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
