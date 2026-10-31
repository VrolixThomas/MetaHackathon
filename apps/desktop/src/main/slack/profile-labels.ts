import { z } from "zod";
import { type SlackCredential, SlackError, SlackIdSchema, abortable, parsed } from "./types";

type LabelMethod = "users.info" | "conversations.members";
interface Conversation {
	id: string;
	name?: string;
	user?: string;
	is_im?: boolean;
	is_mpim?: boolean;
	members?: unknown;
}
interface Members {
	ids: string[];
	partial: boolean;
}
interface Cached<T> {
	value: T | undefined;
	expiresAt: number;
}
interface Scope {
	identity: string;
	profiles: Map<string, Cached<string>>;
	members: Map<string, Cached<Members>>;
}
const NamesSchema = z.object({
	user: z.object({
		id: SlackIdSchema,
		deleted: z.boolean().optional(),
		name: z.string().max(300).nullish(),
		real_name: z.string().max(300).nullish(),
		profile: z
			.object({
				display_name: z.string().max(300).nullish(),
				real_name: z.string().max(300).nullish(),
			})
			.nullish(),
	}),
});
const MembersSchema = z.object({
	members: z.array(SlackIdSchema).max(15),
	response_metadata: z.object({ next_cursor: z.string().max(2000).optional() }).optional(),
});
async function bounded<T, R>(values: T[], work: (value: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(3, values.length) }, async () => {
			while (next < values.length) {
				const index = next++;
				results[index] = await work(values[index] as T);
			}
		})
	);
	return results;
}
function fallback(row: Conversation): string {
	return row.name || row.user || row.id;
}
function compact(value: string): string {
	if (value.length <= 300) return value;
	let prefix = "";
	for (const character of value) {
		if (prefix.length + character.length > 299) break;
		prefix += character;
	}
	return `${prefix}…`;
}

/** Presentation hints only. Cached names and partial member pages never authorize source reads. */
export class SlackProfileLabels {
	private scope?: Scope;
	constructor(
		private readonly options: {
			now(): number;
			assertCurrent(credential: SlackCredential, signal: AbortSignal): Promise<void>;
			request(
				credential: SlackCredential,
				method: LabelMethod,
				fields: Record<string, string | number>,
				signal: AbortSignal
			): Promise<unknown>;
		}
	) {}
	private currentScope(credential: SlackCredential): Scope {
		const identity = JSON.stringify([
			credential.connectionId,
			credential.workspaceId,
			credential.userId,
			credential.appId,
		]);
		if (this.scope?.identity !== identity)
			this.scope = { identity, profiles: new Map(), members: new Map() };
		return this.scope;
	}
	private async lookup<T>(
		credential: SlackCredential,
		cache: Map<string, Cached<T>>,
		key: string,
		capacity: number,
		signal: AbortSignal,
		work: (signal: AbortSignal) => Promise<T | undefined>
	): Promise<T | undefined> {
		const cached = cache.get(key);
		if (cached && cached.expiresAt > this.options.now()) return cached.value;
		let value: T | undefined;
		try {
			const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
			value = await abortable(work(lookupSignal), lookupSignal);
		} catch (error) {
			if (signal.aborted || (error instanceof SlackError && error.code === "stale-connection"))
				throw error;
			// Unavailable or malformed optional metadata is an identity fallback, not a fake person.
		}
		await this.options.assertCurrent(credential, signal);
		cache.delete(key);
		cache.set(key, {
			value,
			expiresAt: this.options.now() + (value === undefined ? 60_000 : 300_000),
		});
		while (cache.size > capacity) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		return value;
	}
	private async resolveUsers(
		credential: SlackCredential,
		ids: string[],
		signal: AbortSignal
	): Promise<Map<string, string>> {
		await this.options.assertCurrent(credential, signal);
		if (!credential.scopes.includes("users:read")) return new Map();
		const scope = this.currentScope(credential);
		let misses = 0;
		const names = new Map<string, string>();
		await bounded(ids, async (id) => {
			const cached = scope.profiles.get(id);
			if (!(cached && cached.expiresAt > this.options.now()) && misses++ >= 15) return;
			const name = await this.lookup(
				credential,
				scope.profiles,
				id,
				256,
				signal,
				async (lookupSignal) => {
					const { user } = parsed(
						NamesSchema,
						await this.options.request(credential, "users.info", { user: id }, lookupSignal)
					);
					if (user.id !== id || user.deleted) return undefined;
					// Peer bots (including Slackbot) are legitimate people-list entries; identity must match.
					return [user.profile?.display_name, user.profile?.real_name, user.real_name, user.name]
						.find((value) => value?.trim())
						?.trim();
				}
			);
			if (name) names.set(id, name);
		});
		await this.options.assertCurrent(credential, signal);
		return names;
	}
	/** Only labels for IDs observed by the caller; never establishes source authorization. */
	async authors(
		credential: SlackCredential,
		authorIds: string[],
		signal: AbortSignal
	): Promise<{ id: string; name: string }[]> {
		const ids = [...new Set(parsed(z.array(SlackIdSchema).max(15), authorIds))];
		const names = await this.resolveUsers(credential, ids, signal);
		await this.options.assertCurrent(credential, signal);
		return ids.map((id) => ({ id, name: names.get(id) || id }));
	}
	async names(
		credential: SlackCredential,
		rows: Conversation[],
		signal: AbortSignal
	): Promise<string[]> {
		if (rows.length > 15) throw new SlackError("invalid-data");
		await this.options.assertCurrent(credential, signal);
		if (!credential.scopes.includes("users:read")) return rows.map(fallback);
		const scope = this.currentScope(credential);
		const members = await bounded(rows, async (row): Promise<Members> => {
			if (row.is_im) return { ids: row.user ? [row.user] : [], partial: false };
			if (!row.is_mpim) return { ids: [], partial: false };
			const observed = Array.isArray(row.members)
				? z.array(SlackIdSchema).max(15).safeParse(row.members.slice(0, 15))
				: undefined;
			if (observed?.success)
				return { ids: observed.data, partial: (row.members as unknown[]).length > 15 };
			return (
				(await this.lookup(credential, scope.members, row.id, 64, signal, async (lookupSignal) => {
					const value = parsed(
						MembersSchema,
						await this.options.request(
							credential,
							"conversations.members",
							{ channel: row.id, limit: 15 },
							lookupSignal
						)
					);
					return { ids: value.members, partial: !!value.response_metadata?.next_cursor };
				})) ?? { ids: [], partial: false }
			);
		});
		const ids = [
			...new Set(
				members.flatMap((row, index) =>
					rows[index]?.is_mpim ? row.ids.filter((id) => id !== credential.userId) : row.ids
				)
			),
		];
		const names = await this.resolveUsers(credential, ids, signal);
		await this.options.assertCurrent(credential, signal);
		return rows.map((row, index) => {
			if (row.is_im) return row.user ? names.get(row.user) || fallback(row) : fallback(row);
			if (!row.is_mpim) return fallback(row);
			const page = members[index];
			const peers = page?.ids.filter((id) => id !== credential.userId) ?? [];
			return peers.length
				? compact(
						`${peers.map((id) => names.get(id) || id).join(", ")}${page?.partial ? ", …" : ""}`
					)
				: fallback(row);
		});
	}
}
