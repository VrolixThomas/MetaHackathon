import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { app } from "electron";
import * as schema from "./schema";

export function openDatabase() {
	const sqlite = new Database(join(app.getPath("userData"), "metahackathon.db"));
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");

	return {
		db: drizzle(sqlite, { schema }),
		close: () => sqlite.close(),
	};
}
