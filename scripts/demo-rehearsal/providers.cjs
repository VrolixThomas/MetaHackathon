// Controlled GitHub/Linear/Slack data only. Model and speech transports are never faked here.
const { execFileSync } = require("node:child_process");
const REPO = "VrolixThomas/MuseFocusDemo";
const ROOT = `/repos/${REPO}`;
const ACTOR = { workspaceId: "TDEMO01", userId: "UDEMO01" };
const CHANNEL = "CDEMO01";
const ORIGINAL = "<@UDEMO01> The focus page is broken for me. Can you take a look?";
const SCOPES =
	"channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,users:read,chat:write";
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
function createSources(fixture, state, report) {
	const git = (...args) => execFileSync("git", args, { cwd: fixture.localPath, encoding: "utf8" });
	const files = (p) =>
		git("diff", "--name-status", p.baseSha, p.headSha)
			.trim()
			.split("\n")
			.map((row) => {
				const [code, filename] = row.split("\t");
				const diff = git(
					"diff",
					"--no-ext-diff",
					"--no-textconv",
					p.baseSha,
					p.headSha,
					"--",
					filename
				);
				const patch = diff.slice(diff.indexOf("@@")).trimEnd();
				return {
					filename,
					status: code === "A" ? "added" : "modified",
					additions: patch.split("\n").filter((l) => l.startsWith("+")).length,
					deletions: patch.split("\n").filter((l) => l.startsWith("-")).length,
					patch,
				};
			});
	const metadata = (p) => ({
		number: p.number,
		state: "open",
		html_url: p.url,
		title: p.title,
		body: fixture.tickets[p.number].description,
		changed_files: files(p).length,
		user: { id: p.number === 2 ? 43751036 : 350732320, login: p.author },
		draft: false,
		updated_at: fixture.tickets[0].updatedAt,
		base: { sha: p.baseSha, ref: "main", repo: { full_name: REPO } },
		head: {
			sha: p.headSha,
			ref: ["demo/quiet-updates", "demo/slack-capture", "demo/source-links"][p.number - 1],
			repo: { full_name: REPO },
		},
	});
	const repo = {
		full_name: REPO,
		default_branch: "main",
		private: false,
		permissions: { pull: true, push: true, admin: true },
	};
	const ticket = (t) => ({
		...t,
		state: state.ticketStates?.[t.id] ?? t.state,
		team: { id: t.teamId, name: t.teamName },
		project: { id: t.projectId, name: t.projectName },
		assignee: { id: t.assigneeId, name: t.assigneeName },
	});
	const sent = [];
	return async (input, init = {}) => {
		const url = new URL(String(input.url ?? input));
		const method = init.method ?? "GET";
		report.sourceRequests.push({ at: Date.now(), host: url.host, path: url.pathname, method });
		if (url.origin === "https://api.github.com") {
			if (method !== "GET") {
				const n = Number(url.pathname.match(/\/pulls\/(\d+)\/reviews$/)?.[1]);
				if (method === "POST" && n === 3 && state.allowApproval) {
					const body = JSON.parse(init.body);
					if (body.event !== "APPROVE" || body.commit_id !== fixture.pulls[2].headSha)
						throw Error("Wrong controlled approval target");
					const receipt = {
						id: 900000 + report.simulatedWrites.length,
						html_url: `${fixture.pulls[2].url}#pullrequestreview-${900000 + report.simulatedWrites.length}`,
						state: "APPROVED",
						commit_id: body.commit_id,
						user: { id: 43751036, login: "VrolixThomas" },
					};
					report.simulatedWrites.push({ provider: "github", body, receipt, at: Date.now() });
					return Response.json(receipt);
				}
				throw Error("Unapproved external write in isolated rehearsal");
			}
			if (url.pathname === "/user")
				return Response.json({ id: 43751036, login: "VrolixThomas", name: "Thomas" });
			if (url.pathname === "/user/repos") return Response.json([repo]);
			if (url.pathname === ROOT) return Response.json(repo);
			if (url.pathname === `${ROOT}/branches/main`)
				return Response.json({ name: "main", protected: false, commit: { sha: fixture.baseline } });
			if (url.pathname === "/search/issues") {
				const ns = url.searchParams.get("q")?.includes("review-requested:") ? [1, 3] : [2];
				return Response.json({
					total_count: ns.length,
					incomplete_results: false,
					items: ns.map((number) => ({
						number,
						repository_url: `https://api.github.com${ROOT}`,
						pull_request: { url: `https://api.github.com${ROOT}/pulls/${number}` },
					})),
				});
			}
			if (url.pathname === `${ROOT}/pulls`) return Response.json(fixture.pulls.map(metadata));
			const match = url.pathname.match(/\/pulls\/(\d+)(?:\/(.*))?$/);
			if (match) {
				const p = fixture.pulls.find((p) => p.number === Number(match[1]));
				if (!p) return Response.json({}, { status: 404 });
				if (!match[2]) return Response.json(metadata(p));
				if (match[2] === "files") return Response.json(files(p));
				if (match[2] === "reviews")
					return Response.json(
						p.number === 2
							? [
									{
										id: 5729768145,
										body: fixture.feedback.body,
										user: { login: "thomasaltacc-a11y" },
										html_url: fixture.feedback.url,
										submitted_at: fixture.feedback.createdAt,
										state: "CHANGES_REQUESTED",
										commit_id: p.headSha,
									},
								]
							: []
					);
				if (match[2] === "comments") return Response.json([]);
			}
			if (/\/issues\/\d+\/comments$/.test(url.pathname)) return Response.json([]);
			if (url.pathname.includes("/contents/")) {
				const path = decodeURIComponent(url.pathname.split("/contents/")[1]);
				try {
					const content = git("show", `${url.searchParams.get("ref")}:${path}`);
					return Response.json({
						path,
						type: "file",
						size: Buffer.byteLength(content),
						encoding: "base64",
						content: Buffer.from(content).toString("base64"),
					});
				} catch {
					return Response.json({}, { status: 404 });
				}
			}
			if (url.pathname.endsWith("/permission"))
				return Response.json({
					permission: "admin",
					user: { id: 43751036, login: "VrolixThomas" },
				});
			if (url.pathname.endsWith("/check-runs"))
				return Response.json({
					total_count: 1,
					check_runs: [
						{
							id: 8001,
							name: "demo-checks",
							status: state.checkStatus === "success" ? "completed" : "in_progress",
							conclusion: state.checkStatus === "success" ? "success" : null,
							app: { id: 15368 },
							html_url: `https://github.com/${REPO}/actions`,
							head_sha: fixture.pulls[2].headSha,
						},
					],
				});
			if (url.pathname.endsWith("/statuses")) return Response.json([]);
			if (url.pathname.endsWith("/status"))
				return Response.json({
					state: state.checkStatus === "success" ? "success" : "pending",
					statuses: [],
				});
			if (url.pathname.includes("/rules")) return Response.json([]);
			if (url.pathname.includes("/protection")) return Response.json({}, { status: 404 });
			if (url.pathname.includes("/compare/"))
				return Response.json({
					status: "identical",
					ahead_by: 0,
					behind_by: 0,
					total_commits: 0,
					merge_base_commit: { sha: fixture.pulls[2].headSha },
					files: [],
				});
			return Response.json({}, { status: 404 });
		}
		if (url.href === "https://api.linear.app/graphql") {
			const { query, variables = {} } = JSON.parse(init.body);
			if (/\bHubViewer\b/.test(query))
				return Response.json({ data: { viewer: { id: "demo-viewer", name: "Thomas" } } });
			if (/\bHubTickets\b/.test(query))
				return Response.json({ data: { issues: page(fixture.tickets.map(ticket)) } });
			if (/\bHubTicket\b/.test(query)) {
				const found = fixture.tickets.find((t) => [t.id, t.identifier].includes(variables.id));
				return Response.json({
					data: {
						issue: found ? ticket(found) : null,
					},
				});
			}
			if (/\bHubTeams\b/.test(query))
				return Response.json({
					data: {
						teams: page([{ id: "rehearsal-team", name: "MuseFocus rehearsal", key: "MET" }]),
					},
				});
			if (/\bHubProjects\b/.test(query))
				return Response.json({
					data: { projects: page([{ id: "rehearsal-project", name: "Keep the thread" }]) },
				});
			if (/\bHubStates\b/.test(query))
				return Response.json({
					data: {
						workflowStates: page([
							{
								id: `rehearsal-${variables.type}`,
								name: variables.type,
								type: variables.type,
								position: 0,
								team: { id: "rehearsal-team" },
							},
						]),
					},
				});
			if (/mutation/.test(query) && /issueUpdate/.test(query)) {
				const t = fixture.tickets.find((t) => t.id === variables.id);
				if (!t) throw Error("Wrong controlled ticket mutation");
				const type = String(variables.stateId ?? variables.input?.stateId ?? "").replace(
					"rehearsal-",
					""
				);
				if (!["started", "completed", "unstarted"].includes(type))
					throw Error("Wrong controlled workflow state");
				state.ticketStates ??= {};
				state.ticketStates[t.id] = { id: `rehearsal-${type}`, name: type, type };
				report.simulatedWrites.push({ provider: "linear", ticketId: t.id, type, at: Date.now() });
				return Response.json({ data: { issueUpdate: { success: true, issue: ticket(t) } } });
			}
			throw Error("Unsupported controlled Linear request");
		}
		if (url.origin === "https://slack.com" && url.pathname.startsWith("/api/")) {
			const name = url.pathname.slice(5);
			const fields =
				name === "chat.postMessage"
					? JSON.parse(init.body)
					: Object.fromEntries(new URLSearchParams(init.body));
			const result = (v) =>
				Response.json({ ok: true, ...v }, { headers: { "x-oauth-scopes": SCOPES } });
			if (name === "auth.test")
				return result({
					team_id: ACTOR.workspaceId,
					user_id: ACTOR.userId,
					team: "MuseFocus rehearsal",
					user: "thomas",
					url: "https://rehearsal.slack.com/",
				});
			if (name === "users.info")
				return result({
					user: {
						id: fields.user,
						team_id: ACTOR.workspaceId,
						name: fields.user === ACTOR.userId ? "thomas" : "alex",
						is_bot: false,
						deleted: false,
						profile: {
							display_name: fields.user === ACTOR.userId ? "Thomas" : "Alex",
							real_name: fields.user === ACTOR.userId ? "Thomas" : "Alex",
						},
					},
				});
			const channel = {
				id: CHANNEL,
				name: "musefocus-rehearsal",
				is_channel: true,
				is_private: false,
				is_member: true,
			};
			if (name === "users.conversations")
				return result({ channels: [channel], response_metadata: { next_cursor: "" } });
			if (name === "conversations.info") return result({ channel });
			if (name === "conversations.members")
				return result({
					members: [ACTOR.userId, "UDEMO02"],
					response_metadata: { next_cursor: "" },
				});
			if (name === "chat.postMessage") {
				if (
					!state.allowSlackQuestion ||
					fields.channel !== CHANNEL ||
					fields.thread_ts !== fixture.ts
				)
					throw Error("Unapproved controlled Slack write");
				const message = {
					ts: `${Math.floor(Date.now() / 1000)}.${String(100 + sent.length).padStart(6, "0")}`,
					thread_ts: fixture.ts,
					user: ACTOR.userId,
					text: fields.text,
				};
				sent.push(message);
				report.simulatedWrites.push({ provider: "slack", message, at: Date.now() });
				return result({ channel: CHANNEL, ts: message.ts, message });
			}
			if (["conversations.history", "conversations.replies"].includes(name)) {
				let messages = state.slackEnabled
					? [
							{
								ts: fixture.ts,
								user: "UDEMO02",
								text: ORIGINAL,
								reply_count: sent.length + Number(!!state.answerText),
							},
						]
					: [];
				if (name === "conversations.replies" && messages.length) {
					messages.push(...sent);
					if (state.answerText)
						messages.push({
							ts: state.answerTs,
							thread_ts: fixture.ts,
							user: "UDEMO02",
							text: state.answerText,
						});
				}
				const compare = (a, b) => BigInt(a.replace(".", "")) - BigInt(b.replace(".", ""));
				messages = messages.filter(
					(m) =>
						(!fields.oldest || compare(m.ts, fields.oldest) >= 0) &&
						(!fields.latest || compare(m.ts, fields.latest) <= 0)
				);
				return result({ messages, has_more: false, response_metadata: { next_cursor: "" } });
			}
			throw Error(`Unsupported controlled Slack method: ${name}`);
		}
		throw Error(`No source transport for ${url.origin}${url.pathname}`);
	};
}
module.exports = { createSources, ACTOR, CHANNEL, ORIGINAL };
