import { createSign } from "node:crypto";
import { z } from "zod";
import { abortable } from "../../apps/desktop/src/main/agent/cancellation";
import type { CredentialAccess } from "../../apps/desktop/src/main/runtime/credentials";
import { GitHubClient } from "../../apps/desktop/src/main/runtime/github";
import type { TeamRepository } from "./access";
import { TeamError, digest } from "./protocol";
import { abortableJson, requestWithTimeout } from "./supabase";

/** Server-only GitHub App credentials. No user or subscription credential pooling. */
export class HostedGitHub {
	constructor(
		private readonly options: {
			appId: string;
			privateKey: string;
			fetch?: typeof fetch;
			now?: () => number;
		}
	) {}
	private jwt() {
		const now = Math.floor((this.options.now ?? Date.now)() / 1000);
		const payload = [
			{ alg: "RS256", typ: "JWT" },
			{ iat: now - 30, exp: now + 540, iss: this.options.appId },
		]
			.map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
			.join(".");
		return `${payload}.${createSign("RSA-SHA256").update(payload).sign(this.options.privateKey, "base64url")}`;
	}
	private async request(
		path: string,
		token: string,
		body?: unknown,
		caller?: AbortSignal
	): Promise<unknown> {
		return requestWithTimeout(20000, caller, async (signal) => {
			let response: Response;
			try {
				response = await abortable(
					(this.options.fetch ?? fetch)(`https://api.github.com${path}`, {
						method: body === undefined ? "GET" : "POST",
						redirect: "error",
						signal,
						headers: {
							Authorization: `Bearer ${token}`,
							Accept: "application/vnd.github+json",
							"X-GitHub-Api-Version": "2022-11-28",
							"Content-Type": "application/json",
						},
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					}),
					signal
				);
			} catch {
				signal.throwIfAborted();
				throw new TeamError("unavailable");
			}
			if (!response.ok)
				throw new TeamError(
					[401, 403, 404].includes(response.status) ? "forbidden" : "unavailable",
					response.status
				);
			return abortableJson(response, 2000000, signal);
		});
	}
	async installation(repository: string, expected?: string, signal?: AbortSignal) {
		signal?.throwIfAborted();
		if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new TeamError("invalid");
		const data = z
			.object({ id: z.number().int().positive(), suspended_at: z.string().nullable() })
			.parse(
				await this.request(`/repos/${repository}/installation`, this.jwt(), undefined, signal)
			);
		signal?.throwIfAborted();
		if (data.suspended_at !== null || (expected && String(data.id) !== expected))
			throw new TeamError("forbidden");
		return String(data.id);
	}

	async authorize(repository: TeamRepository, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		if (!repository.enabled || repository.installation_id === null)
			throw new TeamError("forbidden");
		const jwt = this.jwt();
		const installation = z
			.object({ id: z.number().int(), suspended_at: z.string().nullable() })
			.parse(
				await this.request(
					`/app/installations/${repository.installation_id}`,
					jwt,
					undefined,
					signal
				)
			);
		signal?.throwIfAborted();
		if (
			String(installation.id) !== repository.installation_id ||
			installation.suspended_at !== null
		)
			throw new TeamError("forbidden");
		const issued = z.object({ token: z.string().min(1) }).parse(
			await this.request(
				`/app/installations/${repository.installation_id}/access_tokens`,
				jwt,
				{
					repository_ids: [Number(repository.repository_id)],
					permissions: { contents: "read", pull_requests: "read", metadata: "read" },
				},
				signal
			)
		);
		signal?.throwIfAborted();
		const actual = z
			.object({ id: z.number().int(), full_name: z.string() })
			.parse(
				await this.request(
					`/repositories/${repository.repository_id}`,
					issued.token,
					undefined,
					signal
				)
			);
		signal?.throwIfAborted();
		if (
			String(actual.id) !== repository.repository_id ||
			actual.full_name.toLowerCase() !== repository.full_name.toLowerCase()
		)
			throw new TeamError("forbidden");
		return issued.token;
	}
	async context(repository: TeamRepository, number: number, signal?: AbortSignal) {
		signal?.throwIfAborted();
		const token = await this.authorize(repository, signal);
		signal?.throwIfAborted();
		const credentials = {
			get: async () => token,
			set: async () => {
				throw new Error("Hosted credential mutation forbidden");
			},
			delete: async () => {
				throw new Error("Hosted credential mutation forbidden");
			},
			status: async () => [],
		} satisfies CredentialAccess;
		const client = new GitHubClient(
			credentials,
			// Keep the canonical GitHub context builder, but fence every underlying fetch/body.
			async (input, init) => {
				const url = new URL(String(input));
				if (url.origin !== "https://api.github.com") throw new TeamError("invalid");
				const combined =
					signal && init?.signal
						? AbortSignal.any([signal, init.signal])
						: (signal ?? init?.signal ?? undefined);
				return Response.json(
					await this.request(`${url.pathname}${url.search}`, token, undefined, combined)
				);
			},
			undefined,
			async () => {
				throw new Error("Hosted CLI credentials forbidden");
			}
		);
		const operation = client.prContext(`${repository.full_name}#${number}`, signal);
		const context = signal ? await abortable(operation, signal) : await operation;
		signal?.throwIfAborted();
		const final = z
			.object({
				title: z.string(),
				body: z.string().nullable(),
				head: z.object({ sha: z.string() }),
				base: z.object({ sha: z.string() }),
			})
			.parse(
				await this.request(
					`/repos/${repository.full_name}/pulls/${number}`,
					token,
					undefined,
					signal
				)
			);
		signal?.throwIfAborted();
		if (
			final.head.sha !== context.pr.headSha ||
			final.base.sha !== context.pr.baseSha ||
			final.title !== context.pr.title ||
			(final.body ?? "").slice(0, 32000) !== context.description
		)
			throw new TeamError("conflict");
		return { context, contextDigest: digest(context) };
	}
}
