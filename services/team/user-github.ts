import { z } from "zod";
import { abortable } from "../../apps/desktop/src/main/agent/cancellation";
import type { CredentialAccess } from "../../apps/desktop/src/main/runtime/credentials";
import { GitHubClient } from "../../apps/desktop/src/main/runtime/github";
import { RepositorySchema, type TeamRepository } from "./access";
import { TeamError, digest } from "./protocol";
import { abortableJson, requestWithTimeout } from "./supabase";

/** Request-scoped end-user source reads. No App, model, stored token or CLI fallback. */
export class UserGitHub {
	constructor(private readonly transport: typeof fetch = fetch) {}
	async context(
		rawRepository: TeamRepository,
		number: number,
		signal?: AbortSignal,
		userToken?: string
	) {
		const repository = RepositorySchema.parse(rawRepository);
		if (!repository.enabled) throw new TeamError("forbidden");
		if (!userToken || userToken.length > 32768) throw new TeamError("unauthorized");
		z.int().positive().parse(number);
		return requestWithTimeout(60000, signal, async (operationSignal) => {
			const read = (path: string, caller = operationSignal) =>
				requestWithTimeout(15000, caller, async (readSignal) => {
					let response: Response;
					try {
						response = await abortable(
							this.transport(`https://api.github.com${path}`, {
								redirect: "error",
								signal: readSignal,
								headers: {
									Authorization: `Bearer ${userToken}`,
									Accept: "application/vnd.github+json",
									"X-GitHub-Api-Version": "2022-11-28",
								},
							}),
							readSignal
						);
					} catch {
						readSignal.throwIfAborted();
						throw new TeamError("unavailable");
					}
					if (!response.ok)
						throw new TeamError(
							response.status === 401
								? "unauthorized"
								: response.status === 429 ||
										response.status >= 500 ||
										response.headers.get("x-ratelimit-remaining") === "0" ||
										response.headers.has("retry-after")
									? "unavailable"
									: "forbidden"
						);
					return abortableJson(response, 2000000, readSignal);
				});
			const actual = z
				.object({ id: z.int().positive(), full_name: z.string() })
				.parse(await read(`/repositories/${repository.repository_id}`));
			if (
				String(actual.id) !== repository.repository_id ||
				actual.full_name.toLowerCase() !== repository.full_name.toLowerCase()
			)
				throw new TeamError("forbidden");
			const credentials = {
				get: async () => userToken,
				set: async () => {
					throw new TeamError("forbidden");
				},
				delete: async () => {
					throw new TeamError("forbidden");
				},
				status: async () => [],
			} satisfies CredentialAccess;
			const client = new GitHubClient(
				credentials,
				async (input, init) => {
					const url = new URL(String(input));
					if (url.origin !== "https://api.github.com" || (init?.method && init.method !== "GET"))
						throw new TeamError("invalid");
					const combined = init?.signal
						? AbortSignal.any([operationSignal, init.signal])
						: operationSignal;
					return Response.json(await read(`${url.pathname}${url.search}`, combined));
				},
				undefined,
				async () => {
					throw new TeamError("forbidden");
				}
			);
			const context = await abortable(
				client.prContext(`${repository.full_name}#${number}`, operationSignal),
				operationSignal
			);
			const final = z
				.object({
					number: z.int().positive(),
					html_url: z.string(),
					title: z.string(),
					body: z.string().nullable(),
					user: z.object({ login: z.string() }),
					head: z.object({ sha: z.string() }),
					base: z.object({ sha: z.string(), repo: z.object({ id: z.int().positive() }) }),
				})
				.parse(await read(`/repos/${repository.full_name}/pulls/${number}`));
			if (
				final.number !== number ||
				String(final.base.repo.id) !== repository.repository_id ||
				final.head.sha !== context.pr.headSha ||
				final.base.sha !== context.pr.baseSha ||
				final.title !== context.pr.title ||
				final.html_url !== context.pr.url ||
				final.user.login !== context.pr.author ||
				(final.body ?? "").slice(0, 32000) !== context.description
			)
				throw new TeamError("conflict");
			operationSignal.throwIfAborted();
			return { context, contextDigest: digest(context) };
		});
	}
}
