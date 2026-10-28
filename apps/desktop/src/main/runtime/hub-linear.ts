import { z } from "zod";
import {
	type LinearScope,
	LinearScopeSchema,
	type LinearTicket,
	LinearTicketSchema,
} from "../../shared/contracts";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 10;
const PAGE_SIZE = 50;
const idSchema = z.string().min(1).max(200);
const personSchema = z.object({ id: idSchema, name: z.string().max(200) });
const scopeSchema = z.object({ id: idSchema, name: z.string().max(200) });
const stateSchema = z.object({
	id: idSchema,
	name: z.string().max(100),
	type: z.enum(["triage", "backlog", "unstarted", "started", "completed", "canceled", "cancelled"]),
});
const ticketSchema = z.object({
	id: idSchema,
	identifier: z.string().min(1).max(100),
	title: z.string().min(1).max(1000),
	description: z.string().nullable(),
	url: z.url(),
	updatedAt: z.iso.datetime(),
	state: stateSchema,
	priority: z.int().min(0).max(4),
	team: scopeSchema,
	project: scopeSchema.nullable(),
	assignee: personSchema.nullable(),
});
const pageInfoSchema = z.object({
	hasNextPage: z.boolean(),
	endCursor: z.string().max(1000).nullable(),
});
const connection = <T>(schema: z.ZodType<T>) =>
	z.object({ nodes: z.array(schema).max(PAGE_SIZE), pageInfo: pageInfoSchema });
const TICKET_FIELDS = `id identifier title description url updatedAt priority
	state { id name type } team { id name } project { id name } assignee { id name }`;
const TRUNCATION_MARKER =
	"\n\n[Description truncated: original Linear description exceeds 30000 characters.]";

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) throw new Error("Linear returned invalid or oversized data");
	return result.data;
}
function operationSignal(signal?: AbortSignal): AbortSignal {
	return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]);
}
function mappedTicket(row: z.infer<typeof ticketSchema>, viewerId: string): LinearTicket {
	if (!row.assignee || row.assignee.id !== viewerId)
		throw new Error("Linear ticket is not assigned to the authenticated viewer");
	const description = row.description ?? "";
	return parsed(LinearTicketSchema, {
		id: row.id,
		identifier: row.identifier,
		title: row.title,
		description:
			description.length > 30000
				? description.slice(0, 30000 - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
				: description,
		url: row.url,
		updatedAt: row.updatedAt,
		state: { ...row.state, type: row.state.type === "cancelled" ? "canceled" : row.state.type },
		priority: row.priority,
		teamId: row.team.id,
		teamName: row.team.name,
		projectId: row.project?.id ?? null,
		projectName: row.project?.name ?? null,
		assigneeId: row.assignee.id,
		assigneeName: row.assignee.name,
	});
}

/** Uses only Linear's public GraphQL API; credentials stay inside the injected main callback. */
export class HubLinearClient {
	private readonly transport: typeof fetch;
	private readonly inFlight = new Set<Promise<void>>();
	private waiting = 0;
	constructor(
		private readonly options: {
			getKey: () => Promise<string | undefined>;
			fetch?: typeof fetch;
		}
	) {
		this.transport = options.fetch ?? fetch;
	}
	private async slot(signal: AbortSignal): Promise<() => void> {
		if (this.waiting >= 64) throw new Error("Linear request queue is full; retry later");
		this.waiting++;
		let onAbort = () => {};
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("Linear request cancelled or timed out"));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			while (this.inFlight.size >= 4) {
				if (signal.aborted) throw new Error("Linear request cancelled or timed out");
				await Promise.race([...this.inFlight, aborted]);
			}
			if (signal.aborted) throw new Error("Linear request cancelled or timed out");
			let release = () => {};
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			this.inFlight.add(pending);
			return () => {
				this.inFlight.delete(pending);
				release();
			};
		} finally {
			this.waiting--;
			signal.removeEventListener("abort", onAbort);
		}
	}
	// Personal API keys use the raw Authorization value. An explicitly supplied "Bearer ..."
	// value is preserved for OAuth; the adapter never infers OAuth from a token prefix.
	// https://linear.app/developers/graphql, https://linear.app/developers/filtering
	private async gql<T>(
		query: string,
		variables: Record<string, unknown>,
		schema: z.ZodType<T>,
		signal?: AbortSignal
	): Promise<T> {
		const boundedSignal = AbortSignal.any([
			...(signal ? [signal] : []),
			AbortSignal.timeout(20_000),
		]);
		let key: string | undefined;
		try {
			key = (await this.options.getKey())?.trim();
		} catch {
			throw new Error("Linear credentials unavailable");
		}
		if (!key || key.length > 16384 || /[\r\n]/.test(key))
			throw new Error("Linear connection required. Configure LINEAR_API_KEY in the app .env file.");
		const release = await this.slot(boundedSignal);
		try {
			let response: Response;
			try {
				response = await this.transport("https://api.linear.app/graphql", {
					method: "POST",
					signal: boundedSignal,
					redirect: "error",
					headers: {
						Authorization: key,
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify({ query, variables }),
				});
			} catch {
				throw new Error(
					boundedSignal.aborted ? "Linear request cancelled or timed out" : "Linear request failed"
				);
			}
			if (!response.ok) {
				void response.body?.cancel().catch(() => undefined);
				if (response.status === 401)
					throw new Error("Linear API key expired or invalid. Check LINEAR_API_KEY.");
				if (response.status === 403)
					throw new Error("Linear access denied. Check API key permissions and selected teams.");
				if (response.status === 429) throw new Error("Linear rate limit reached; retry later.");
				throw new Error(`Linear returned HTTP ${response.status}`);
			}
			if (!response.body) throw new Error("Linear returned an empty response");
			const reader = response.body.getReader();
			const cancel = () => {
				void reader.cancel().catch(() => undefined);
			};
			boundedSignal.addEventListener("abort", cancel, { once: true });
			let data: unknown;
			try {
				const chunks: Uint8Array[] = [];
				let bytes = 0;
				while (true) {
					if (boundedSignal.aborted) throw new Error("Linear request cancelled or timed out");
					const { value, done } = await reader.read();
					if (done) break;
					bytes += value.byteLength;
					if (bytes > MAX_RESPONSE_BYTES)
						throw new Error("Linear response exceeds the bounded read limit");
					chunks.push(value);
				}
				if (boundedSignal.aborted) throw new Error("Linear request cancelled or timed out");
				data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch (error) {
				if (boundedSignal.aborted) throw new Error("Linear request cancelled or timed out");
				if (
					error instanceof Error &&
					/^(Linear request cancelled|Linear response exceeds)/.test(error.message)
				)
					throw error;
				throw new Error("Linear returned an unreadable JSON response");
			} finally {
				boundedSignal.removeEventListener("abort", cancel);
				cancel();
				reader.releaseLock();
			}
			const envelope = parsed(
				z.object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() }),
				data
			);
			if (envelope.errors?.length)
				throw new Error(
					"Linear GraphQL request failed. Check API key access and retry; no partial data was accepted."
				);
			return parsed(schema, envelope.data);
		} finally {
			release();
		}
	}
	async viewer(signal?: AbortSignal): Promise<{ id: string; name: string }> {
		return (
			await this.gql(
				"query HubViewer { viewer { id name } }",
				{},
				z.object({ viewer: personSchema }),
				signal
			)
		).viewer;
	}
	private async pages<T>(
		read: (
			cursor: string | null
		) => Promise<{ nodes: T[]; pageInfo: z.infer<typeof pageInfoSchema> }>
	): Promise<T[]> {
		const rows: T[] = [];
		let cursor: string | null = null;
		const seen = new Set<string>();
		for (let page = 0; page < MAX_PAGES; page++) {
			const data = await read(cursor);
			rows.push(...data.nodes);
			if (!data.pageInfo.hasNextPage) return rows;
			const next = data.pageInfo.endCursor;
			if (!next || seen.has(next)) throw new Error("Linear returned an invalid pagination cursor");
			seen.add(next);
			cursor = next;
		}
		throw new Error(
			"Linear results exceed the bounded 500-item read limit; narrow the selected scopes"
		);
	}
	async scopes(signal?: AbortSignal): Promise<LinearScope[]> {
		const boundedSignal = operationSignal(signal);
		const teams = await this.pages(
			async (cursor) =>
				(
					await this.gql(
						"query HubTeams($cursor: String) { teams(first: 50, after: $cursor) { nodes { id name key } pageInfo { hasNextPage endCursor } } }",
						{ cursor },
						z.object({ teams: connection(scopeSchema.extend({ key: z.string().max(50) })) }),
						boundedSignal
					)
				).teams
		);
		const projects = await this.pages(
			async (cursor) =>
				(
					await this.gql(
						"query HubProjects($cursor: String) { projects(first: 50, after: $cursor) { nodes { id name } pageInfo { hasNextPage endCursor } } }",
						{ cursor },
						z.object({ projects: connection(scopeSchema) }),
						boundedSignal
					)
				).projects
		);
		return [
			...teams.map((row) => parsed(LinearScopeSchema, { ...row, kind: "team" })),
			...projects.map((row) => parsed(LinearScopeSchema, { ...row, kind: "project" })),
		];
	}
	async tickets(
		input: { teamIds: string[]; projectIds: string[] },
		signal?: AbortSignal
	): Promise<LinearTicket[]> {
		const scopes = z
			.strictObject({ teamIds: z.array(idSchema).max(50), projectIds: z.array(idSchema).max(100) })
			.parse(input);
		const boundedSignal = operationSignal(signal);
		const viewer = await this.viewer(boundedSignal);
		const selected = [
			...(scopes.teamIds.length ? [{ team: { id: { in: scopes.teamIds } } }] : []),
			...(scopes.projectIds.length ? [{ project: { id: { in: scopes.projectIds } } }] : []),
		];
		// Selected team/project scopes form a union, always intersected with viewer ownership.
		const filter = {
			assignee: { id: { eq: viewer.id } },
			...(selected.length ? { or: selected } : {}),
		};
		const rows = await this.pages(
			async (cursor) =>
				(
					await this.gql(
						`query HubTickets($cursor: String, $filter: IssueFilter) { issues(first: 50, after: $cursor, filter: $filter, orderBy: updatedAt) { nodes { ${TICKET_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
						{ cursor, filter },
						z.object({ issues: connection(ticketSchema) }),
						boundedSignal
					)
				).issues
		);
		const tickets = rows.map((row) => mappedTicket(row, viewer.id));
		if (
			tickets.some(
				(ticket) =>
					selected.length &&
					!scopes.teamIds.includes(ticket.teamId) &&
					!(ticket.projectId && scopes.projectIds.includes(ticket.projectId))
			)
		)
			throw new Error("Linear returned a ticket outside the selected scopes");
		return [...new Map(tickets.map((ticket) => [ticket.id, ticket])).values()];
	}
	private async ownedTicket(
		id: string,
		viewerId: string,
		signal: AbortSignal
	): Promise<LinearTicket> {
		const data = await this.gql(
			`query HubTicket($id: String!) { issue(id: $id) { ${TICKET_FIELDS} } }`,
			{ id: idSchema.parse(id) },
			z.object({ issue: ticketSchema.nullable() }),
			signal
		);
		if (!data.issue) throw new Error("Linear ticket not found or inaccessible");
		if (data.issue.id !== id && data.issue.identifier.toLowerCase() !== id.toLowerCase())
			throw new Error("Linear returned a different ticket");
		return mappedTicket(data.issue, viewerId);
	}
	async ticket(id: string, signal?: AbortSignal): Promise<LinearTicket> {
		idSchema.parse(id);
		const boundedSignal = operationSignal(signal);
		const viewer = await this.viewer(boundedSignal);
		return this.ownedTicket(id, viewer.id, boundedSignal);
	}
	async updateState(
		ticketId: string,
		targetType: "started" | "completed" | "unstarted",
		signal?: AbortSignal
	): Promise<LinearTicket> {
		idSchema.parse(ticketId);
		z.enum(["started", "completed", "unstarted"]).parse(targetType);
		const boundedSignal = operationSignal(signal);
		const viewer = await this.viewer(boundedSignal);
		const ticket = await this.ownedTicket(ticketId, viewer.id, boundedSignal);
		if (ticket.state.type === targetType) return ticket;
		const rows = await this.pages(
			async (cursor) =>
				(
					await this.gql(
						"query HubStates($teamId: ID!, $type: String!, $cursor: String) { workflowStates(first: 50, after: $cursor, filter: { team: { id: { eq: $teamId } }, type: { eq: $type } }) { nodes { id name type position team { id } } pageInfo { hasNextPage endCursor } } }",
						{ teamId: ticket.teamId, type: targetType, cursor },
						z.object({
							workflowStates: connection(
								stateSchema.extend({
									position: z.number().finite(),
									team: z.object({ id: idSchema }),
								})
							),
						}),
						boundedSignal
					)
				).workflowStates
		);
		if (rows.some((row) => row.team.id !== ticket.teamId || row.type !== targetType))
			throw new Error("Linear returned workflow states outside the ticket team and requested type");
		const state = rows.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))[0];
		if (!state) throw new Error("Linear team has no workflow state of the requested type");
		// Recheck ownership just before the mutation; never change another person's ticket.
		const current = await this.ownedTicket(ticket.id, viewer.id, boundedSignal);
		if (current.teamId !== ticket.teamId)
			throw new Error("Linear ticket changed teams; refresh before updating");
		const data = await this.gql(
			`mutation HubUpdateState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { ${TICKET_FIELDS} } } }`,
			{ id: ticket.id, stateId: state.id },
			z.object({ issueUpdate: z.object({ success: z.boolean(), issue: ticketSchema.nullable() }) }),
			boundedSignal
		);
		if (!data.issueUpdate.success || !data.issueUpdate.issue)
			throw new Error("Linear did not confirm the ticket state update; refresh before retrying");
		const updated = mappedTicket(data.issueUpdate.issue, viewer.id);
		if (
			updated.id !== ticket.id ||
			updated.teamId !== ticket.teamId ||
			updated.state.type !== targetType ||
			updated.state.id !== state.id
		)
			throw new Error(
				"Linear returned an unexpected ticket after the state update; refresh before retrying"
			);
		return updated;
	}
}
