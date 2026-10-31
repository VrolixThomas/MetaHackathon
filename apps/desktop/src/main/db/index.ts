import { chmodSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { app } from "electron";
import { DAY_STORE_MIGRATION_SQL, DayStore } from "./day-store";
import { HubStore } from "./hub-store";
import { KNOWLEDGE_STORE_MIGRATION_SQL, KnowledgeStore } from "./knowledge-store";
import { ReviewStore } from "./review-store";
import { RuntimeState } from "./runtime-state";
import * as schema from "./schema";
import { SLACK_STORE_MIGRATION_SQL, SlackWorkspaceStore } from "./slack-store";

export function openDatabase() {
	const path = join(app.getPath("userData"), "metahackathon.db");
	const sqlite = new Database(path);
	chmodSync(path, 0o600);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	sqlite.exec(DAY_STORE_MIGRATION_SQL);
	sqlite.exec(KNOWLEDGE_STORE_MIGRATION_SQL);
	sqlite.exec(SLACK_STORE_MIGRATION_SQL);

	return {
		db: drizzle(sqlite, { schema }),
		runtime: new RuntimeState(sqlite),
		reviews: new ReviewStore(sqlite),
		hub: new HubStore(sqlite),
		day: new DayStore(sqlite),
		knowledge: new KnowledgeStore(sqlite),
		slack: new SlackWorkspaceStore(sqlite),
		close: () => sqlite.close(),
	};
}
