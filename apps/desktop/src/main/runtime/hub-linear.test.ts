import assert from "node:assert/strict";
import { test } from "node:test";
import { HubLinearClient } from "./hub-linear";

const viewer = { id: "viewer-id", name: "Viewer Name" };
function ticket(id = "ticket-id") {
	return {
		id,
		identifier: "MET-48",
		title: "Implement provider adapters",
		description: "Actual ticket description\n\nAcceptance criteria.",
		url: "https://linear.app/team/issue/MET-48",
		updatedAt: "2026-10-28T12:00:00Z",
		state: { id: "todo", name: "Todo", type: "unstarted" },
		priority: 2,
		team: { id: "team-id", name: "Team" },
		project: { id: "project-id", name: "Project" },
		assignee: viewer,
	};
}
function connection(nodes: unknown[], endCursor: string | null = null, hasNextPage = false) {
	return { nodes, pageInfo: { hasNextPage, endCursor } };
}
type Variables = Record<string, unknown>;
type Handler = (
	query: string,
	variables: Variables,
	init: RequestInit
) => Response | Promise<Response>;
function client(handler: Handler, key = "lin_api_test-key") {
	return new HubLinearClient({
		getKey: async () => key,
		fetch: (async (input, init) => {
			assert.equal(String(input), "https://api.linear.app/graphql");
			assert.equal(init?.method, "POST");
			assert.equal(init?.redirect, "error");
			assert.equal(new Headers(init?.headers).get("Authorization"), key);
			const body = JSON.parse(String(init?.body));
			return handler(body.query, body.variables, init ?? {});
		}) as typeof fetch,
	});
}
function data(value: unknown) {
	return Response.json({ data: value });
}
function defaultHandler(query: string) {
	return data(
		query.includes("HubViewer")
			? { viewer }
			: query.includes("HubTickets")
				? { issues: connection([ticket()]) }
				: { issue: ticket() }
	);
}

test("Linear raw personal-key auth and explicitly provided OAuth Bearer are preserved", async () => {
	assert.deepEqual(await client(() => data({ viewer })).viewer(), viewer);
	assert.deepEqual(
		await client(() => data({ viewer }), "Bearer explicit-oauth-token").viewer(),
		viewer
	);
});

test("teams and projects are cursor-paginated into actual selectable scopes", async () => {
	const requests: [string, Variables][] = [];
	const scopes = await client((query, variables) => {
		requests.push([query.includes("HubTeams") ? "teams" : "projects", variables]);
		return data(
			query.includes("HubTeams")
				? {
						teams: variables["cursor"]
							? connection([{ id: "second", name: "Second team", key: "SEC" }])
							: connection([{ id: "first", name: "First team", key: "FST" }], "next-team", true),
					}
				: { projects: connection([{ id: "project-id", name: "Project" }]) }
		);
	}).scopes();
	assert.deepEqual(
		scopes.map((scope) => [scope.id, scope.kind]),
		[
			["first", "team"],
			["second", "team"],
			["project-id", "project"],
		]
	);
	assert.deepEqual(
		requests.map(([kind, variables]) => [kind, variables["cursor"]]),
		[
			["teams", null],
			["teams", "next-team"],
			["projects", null],
		]
	);
});

test("tickets always filter by authenticated viewer; empty scopes select all own", async () => {
	let filter: unknown;
	const tickets = await client((query, variables) => {
		if (query.includes("HubTickets")) filter = variables["filter"];
		return defaultHandler(query);
	}).tickets({ teamIds: [], projectIds: [] });
	assert.deepEqual(filter, { assignee: { id: { eq: viewer.id } } });
	assert.equal(tickets[0]?.assigneeId, viewer.id);
	assert.equal(tickets[0]?.description, ticket().description);
	assert.equal(tickets[0]?.projectName, "Project");
});

test("selected teams and projects union is intersected with viewer ownership and cursor pages", async () => {
	const filters: unknown[] = [];
	const cursors: unknown[] = [];
	const rows = await client((query, variables) => {
		if (query.includes("HubViewer")) return data({ viewer });
		filters.push(variables["filter"]);
		cursors.push(variables["cursor"]);
		return data({
			issues: variables["cursor"]
				? connection([{ ...ticket("second"), team: { id: "other-team", name: "Other team" } }])
				: connection([ticket()], "cursor-two", true),
		});
	}).tickets({ teamIds: ["team-id"], projectIds: ["project-id"] });
	assert.equal(rows.length, 2);
	assert.deepEqual(cursors, [null, "cursor-two"]);
	assert.deepEqual(filters[0], {
		assignee: { id: { eq: viewer.id } },
		or: [{ team: { id: { in: ["team-id"] } } }, { project: { id: { in: ["project-id"] } } }],
	});
});

test("tickets reject unexpected unassigned, other-user and out-of-scope results", async () => {
	for (const row of [
		{ ...ticket(), assignee: null },
		{ ...ticket(), assignee: { id: "other", name: "Other" } },
		{ ...ticket(), team: { id: "outside", name: "Outside" }, project: null },
	])
		await assert.rejects(
			client((query) =>
				data(query.includes("HubViewer") ? { viewer } : { issues: connection([row]) })
			).tickets({ teamIds: ["team-id"], projectIds: [] }),
			/assigned to|outside the selected scopes/
		);
});

test("single ticket checks ownership, preserves description and normalizes cancelled spelling", async () => {
	const row = { ...ticket(), state: { id: "cancelled", name: "Canceled", type: "cancelled" } };
	const actual = await client((query) =>
		data(query.includes("HubViewer") ? { viewer } : { issue: row })
	).ticket("MET-48");
	assert.equal(actual.state.type, "canceled");
	assert.equal(actual.description, row.description);
	await assert.rejects(
		client((query) =>
			data(
				query.includes("HubViewer")
					? { viewer }
					: { issue: { ...ticket(), assignee: { id: "other", name: "Other" } } }
			)
		).ticket("MET-48"),
		/assigned to/
	);
	await assert.rejects(
		client((query) => data(query.includes("HubViewer") ? { viewer } : { issue: null })).ticket(
			"MET-48"
		),
		/not found/
	);
});

test("descriptions within bound are verbatim; over-bound descriptions have an explicit truncation marker", async () => {
	for (const length of [30000, 30001]) {
		const description = "x".repeat(length);
		const row = await client((query) =>
			data(query.includes("HubViewer") ? { viewer } : { issue: { ...ticket(), description } })
		).ticket("MET-48");
		assert.equal(row.description.length, 30000);
		if (length === 30000) assert.equal(row.description, description);
		else {
			assert.ok(
				row.description.endsWith(
					"[Description truncated: original Linear description exceeds 30000 characters.]"
				)
			);
			assert.ok(description.startsWith(row.description.split("\n")[0] ?? ""));
		}
	}
});

test("updateState selects an actual matching team workflow state and returns the actual mutation result", async () => {
	let reads = 0;
	let writes = 0;
	const updated = {
		...ticket(),
		state: { id: "started-first", name: "In Progress", type: "started" },
		updatedAt: "2026-10-28T13:00:00Z",
	};
	const result = await client((query, variables) => {
		if (query.includes("HubViewer")) return data({ viewer });
		if (query.includes("HubStates")) {
			assert.equal(variables["teamId"], "team-id");
			assert.equal(variables["type"], "started");
			return data({
				workflowStates: connection([
					{
						id: "started-last",
						name: "Other",
						type: "started",
						position: 3,
						team: { id: "team-id" },
					},
					{ ...updated.state, position: 1, team: { id: "team-id" } },
				]),
			});
		}
		if (query.includes("HubUpdateState")) {
			writes++;
			assert.deepEqual(variables, { id: "ticket-id", stateId: "started-first" });
			return data({ issueUpdate: { success: true, issue: updated } });
		}
		reads++;
		return data({ issue: ticket() });
	}).updateState("MET-48", "started");
	assert.equal(reads, 2);
	assert.equal(writes, 1);
	assert.equal(result.updatedAt, updated.updatedAt);
	assert.deepEqual(result.state, updated.state);
});

test("updateState never mutates unowned tickets or when ownership changes before mutation", async () => {
	for (const changesAt of [1, 2]) {
		let reads = 0;
		let writes = 0;
		await assert.rejects(
			client((query) => {
				if (query.includes("HubViewer")) return data({ viewer });
				if (query.includes("HubStates"))
					return data({
						workflowStates: connection([
							{
								id: "started",
								name: "Started",
								type: "started",
								position: 1,
								team: { id: "team-id" },
							},
						]),
					});
				if (query.includes("HubUpdateState")) {
					writes++;
					throw new Error("must not mutate");
				}
				return data({
					issue: {
						...ticket(),
						assignee: ++reads >= changesAt ? { id: "other", name: "Other" } : viewer,
					},
				});
			}).updateState("MET-48", "started"),
			/assigned to/
		);
		assert.equal(writes, 0);
	}
});

test("state updates reject missing state and failed/mismatched provider mutation confirmation", async () => {
	for (const mode of ["missing", "failed", "mismatch"]) {
		await assert.rejects(
			client((query) => {
				if (query.includes("HubViewer")) return data({ viewer });
				if (query.includes("HubStates"))
					return data({
						workflowStates: connection(
							mode === "missing"
								? []
								: [
										{
											id: "started",
											name: "Started",
											type: "started",
											position: 1,
											team: { id: "team-id" },
										},
									]
						),
					});
				if (query.includes("HubUpdateState"))
					return data({ issueUpdate: { success: mode !== "failed", issue: ticket() } });
				return data({ issue: ticket() });
			}).updateState("MET-48", "started"),
			/no workflow state|did not confirm|unexpected ticket/
		);
	}
});

test("pagination rejects repeated/missing cursors and over-500 results without partial success", async () => {
	for (const mode of ["repeated", "missing", "limit"]) {
		let pages = 0;
		await assert.rejects(
			client((query) => {
				if (query.includes("HubViewer")) return data({ viewer });
				pages++;
				return data({
					issues: connection(
						[ticket(`ticket-${pages}`)],
						mode === "missing" ? null : mode === "repeated" ? "same" : `cursor-${pages}`,
						true
					),
				});
			}).tickets({ teamIds: [], projectIds: [] }),
			/pagination cursor|500-item/
		);
		assert.equal(pages, mode === "limit" ? 10 : mode === "repeated" ? 2 : 1);
	}
});

test("GraphQL errors on HTTP 200 reject partial data and sanitize provider errors and credentials", async () => {
	await assert.rejects(
		client(() =>
			Response.json({
				data: { viewer },
				errors: [{ message: "secret-token private provider details" }],
			})
		).viewer(),
		(error: Error) =>
			error.message.includes("GraphQL request failed") && !error.message.includes("secret-token")
	);
	for (const status of [301, 401, 403, 429, 500])
		await assert.rejects(
			client(() => new Response("secret-token", { status })).viewer(),
			(error: Error) => !error.message.includes("secret-token")
		);
	await assert.rejects(
		client(() => {
			throw new Error("secret-token");
		}).viewer(),
		/request failed/
	);
	await assert.rejects(
		client(() => data({ viewer: { ...viewer, name: "x".repeat(201) } })).viewer(),
		/invalid or oversized/
	);
});

test("missing credentials, invalid input and cancellation prevent dispatch", async () => {
	let calls = 0;
	const linear = new HubLinearClient({
		getKey: async () => undefined,
		fetch: (async () => {
			calls++;
			throw new Error("unexpected dispatch");
		}) as typeof fetch,
	});
	await assert.rejects(linear.viewer(), /connection required/);
	await assert.rejects(
		client(() => {
			calls++;
			return data({ viewer });
		}).ticket("")
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		client(() => {
			calls++;
			return data({ viewer });
		}).viewer(controller.signal),
		/cancelled/
	);
	assert.equal(calls, 0);
});

test("byte limit and abort bound streamed response bodies", async () => {
	await assert.rejects(
		client(() => new Response("x".repeat(4 * 1024 * 1024 + 1))).viewer(),
		/bounded read/
	);
	await assert.rejects(
		client(() => new Response("secret-invalid-json")).viewer(),
		/unreadable JSON/
	);
	const controller = new AbortController();
	await assert.rejects(
		client(
			() =>
				new Response(
					new ReadableStream({
						start() {
							queueMicrotask(() => controller.abort());
						},
					})
				)
		).viewer(controller.signal),
		/cancelled/
	);
});

test("Linear transport caps concurrent requests and safely resumes queued work", async () => {
	const releases: (() => void)[] = [];
	let active = 0;
	let peak = 0;
	const linear = client(async () => {
		active++;
		peak = Math.max(active, peak);
		await new Promise<void>((resolve) => releases.push(resolve));
		active--;
		return data({ viewer });
	});
	const calls = Array.from({ length: 6 }, () => linear.viewer());
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(active, 4);
	for (const resolve of releases.splice(0)) resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (const resolve of releases.splice(0)) resolve();
	await Promise.all(calls);
	assert.equal(peak, 4);
});
