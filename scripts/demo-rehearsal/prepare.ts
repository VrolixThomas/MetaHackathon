// Explicit isolated rehearsal setup, never a product startup import.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { HubStore } from "../../apps/desktop/src/main/db/hub-store";
import { ReviewStore } from "../../apps/desktop/src/main/db/review-store";
import { HubPersistenceSchema, LinearTicketSchema } from "../../apps/desktop/src/shared/contracts";

export async function prepare(root: string, data: string, reuseReviews?: string) {
	const now = new Date().toISOString();
	const profile = join(root, "profile");
	const localPath = join(root, "companion");
	mkdirSync(profile, { recursive: true, mode: 0o700 });
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: localPath, encoding: "utf8" });
	execFileSync("git", ["clone", "--quiet", join(data, "companion.bundle"), localPath]);
	const repository = {
		id: "vrolixthomas/musefocusdemo",
		repository: "VrolixThomas/MuseFocusDemo",
		localPath,
		defaultBranch: "main",
		addedAt: now,
		linearTeamIds: [],
		linearProjectIds: [],
	};
	git("remote", "set-url", "origin", `https://github.com/${repository.repository}.git`);
	git("config", "user.name", "MuseFocus rehearsal");
	git("config", "user.email", "rehearsal@example.invalid");
	const manifest = JSON.parse(readFileSync(join(data, "scenes.json"), "utf8")) as {
		pullRequests: {
			number: number;
			title: string;
			url: string;
			author: { login: string };
			headRefOid: string;
		}[];
	};
	const baseline = git("rev-parse", "b067f9c").trim();
	const pulls = manifest.pullRequests.map((p) => ({
		id: `${repository.repository}#${p.number}`,
		number: p.number,
		repository: repository.repository,
		title: p.title,
		author: p.author.login,
		url: p.url,
		baseSha: baseline,
		headSha: p.headRefOid,
	}));
	const descriptions = [
		"When I turn on focus mode in the MuseFocus companion and refresh the browser, keep focus mode on. A refresh should not turn a quiet session into an interruption. First visit starts off; turning off persists too. Keep usable in memory if storage is blocked. Decide whether it should last only in this tab or also across browser restarts; suggested v1 is device-local across restarts, no account sync. Keep changes small, no new dependencies, and run npm test and npm run build. Discuss before starting; a suggested default is not a decision.",
		"Ready-work and decision updates must both wait while focus is active. After focus, decisions come first. Held updates remain queued; delivered updates never repeat. Inspect the decision-during-focus case, not only completed-work deferral.",
		"Each original Slack message is one request: key by workspace, channel and message. Replays deduplicate, different messages remain separate, different workspaces remain separate. Preserve original thread and source URL. Capture grants neither send nor coding authority.",
		"Add safe HTTPS Open source links to work cards, omit missing/unsafe links, and use noopener/noreferrer. The named demo-checks check must succeed on the inspected head. Approval is separate from merging.",
	];
	const titles = [
		"Remember focus mode when I refresh the companion",
		"Hold ready-work updates while focus mode is on",
		"Keep each Slack request linked to its original message",
		"Open the original source from a work card",
	];
	const tickets = titles.map((title, i) =>
		LinearTicketSchema.parse({
			id: `rehearsal-ticket-${77 + i}`,
			identifier: `MET-${77 + i}`,
			title,
			description: descriptions[i],
			url: `https://linear.app/metahackathon/issue/MET-${77 + i}`,
			updatedAt: now,
			state: { id: "rehearsal-todo", name: "Todo", type: "unstarted" },
			priority: i < 2 ? 2 : 3,
			teamId: "rehearsal-team",
			teamName: "MuseFocus rehearsal",
			projectId: "rehearsal-project",
			projectName: "Keep the thread",
			assigneeId: "demo-viewer",
			assigneeName: "Thomas",
		})
	);
	const feedback = {
		id: `${pulls[1].id}:review:5729768145`,
		prId: pulls[1].id,
		author: "thomasaltacc-a11y",
		body: "Two requests in the same channel overwrite each other. Include original messageId in the item key and add regressions for separate messages, replay and different workspaces. Preserve thread and URL.",
		url: `${pulls[1].url}#pullrequestreview-5729768145`,
		createdAt: now,
		updatedAt: now,
		kind: "review",
		state: "CHANGES_REQUESTED",
		path: null,
		line: null,
		commitSha: pulls[1].headSha,
		suggestion: null,
	};
	const db = new Database(join(profile, "metahackathon.db"));
	const hub = new HubStore(db);
	await hub.saveState(
		HubPersistenceSchema.parse({
			version: 1,
			repositories: [repository],
			preferences: {
				linearTeamIds: [],
				linearProjectIds: ["rehearsal-project"],
				autoApplySuggestions: false,
			},
			tickets,
			jobs: [],
			notices: [],
		})
	);
	let prepared: Awaited<ReturnType<ReviewStore["load"]>>["prepared"] = [];
	let reusedFromRunId: string | null = null;
	if (reuseReviews) {
		const previous = realpathSync(reuseReviews);
		if (
			dirname(previous) !== realpathSync(tmpdir()) ||
			!basename(previous).startsWith("musefocus-rehearsal-")
		)
			throw Error("Review reuse requires an owned rehearsal directory");
		const owner = readFileSync(join(previous, ".owner"), "utf8");
		const report = JSON.parse(readFileSync(join(previous, "report.json"), "utf8"));
		if (owner !== report.runId || !report.liveModels || !report.scriptedASR)
			throw Error("Only actual-model rehearsal reviews may be reused");
		const oldDb = new Database(join(previous, "profile/metahackathon.db"), { readonly: true });
		try {
			prepared = (await new ReviewStore(oldDb).load()).prepared;
		} finally {
			oldDb.close();
		}
		if (
			prepared.length !== pulls.length ||
			prepared.some(
				(review) =>
					!pulls.some(
						(pull) =>
							pull.id === review.pr.id &&
							pull.baseSha === review.pr.baseSha &&
							pull.headSha === review.pr.headSha
					)
			)
		)
			throw Error("Reused review pins must exactly match all rehearsal PRs");
		reusedFromRunId = owner;
	}
	const cache = { repository: repository.repository, localPath, prepared, progress: [] };
	await hub.saveReview(repository.repository, cache);
	await new ReviewStore(db).save(cache);
	db.close();
	return {
		profile,
		localPath,
		repository,
		baseline,
		pulls,
		tickets,
		feedback,
		prepared,
		reusedFromRunId,
		ts: `${Math.floor(Date.now() / 1000)}.000001`,
	};
}
