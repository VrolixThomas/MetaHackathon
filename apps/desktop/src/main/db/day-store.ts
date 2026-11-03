import type Database from "better-sqlite3";
import { type DayState, parseDayState } from "../day/model";
import {
	type StandingState,
	emptyStandingState,
	parseStandingState,
} from "../day/standing-clarification";

export const MAX_DAY_STATE_BYTES = 32 * 1024 * 1024;
/** Root registers this additive migration on the existing SQLite connection before creating DayStore. */
export const DAY_STORE_MIGRATION_SQL = `
	CREATE TABLE IF NOT EXISTS day_state (
		id INTEGER PRIMARY KEY CHECK(id=1),
		sequence INTEGER NOT NULL CHECK(sequence>=0),
		data_json TEXT NOT NULL
	);
 CREATE TABLE IF NOT EXISTS standing_clarification_state (id INTEGER PRIMARY KEY CHECK(id=1), data_json TEXT NOT NULL);
`;
const STORED = "Stored day data is invalid or unreadable; existing records were preserved";
const INPUT = "Day data is invalid or could not be saved; existing records were preserved";

export class DayStore {
	constructor(private readonly sqlite: Database.Database) {}
	async standingTransaction<T>(mutate: (state: StandingState) => T): Promise<T> {
		return this.sqlite.transaction(() => {
			const row = this.sqlite
				.prepare("SELECT data_json FROM standing_clarification_state WHERE id=1")
				.get() as { data_json: string } | undefined;
			if (row && Buffer.byteLength(row.data_json) > MAX_DAY_STATE_BYTES) throw new Error(STORED);
			const state = row ? parseStandingState(JSON.parse(row.data_json)) : emptyStandingState();
			const result = mutate(state);
			if (result && typeof result === "object" && "then" in result)
				throw new Error("Standing transactions must be synchronous");
			const copy = structuredClone(result);
			const data = JSON.stringify(parseStandingState(state));
			if (Buffer.byteLength(data) > MAX_DAY_STATE_BYTES) throw new Error(INPUT);
			if (data !== row?.data_json)
				this.sqlite
					.prepare(
						"INSERT INTO standing_clarification_state(id,data_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json"
					)
					.run(data);
			return copy;
		})();
	}
	async loadState(): Promise<DayState | null> {
		try {
			return this.sqlite.transaction(() => {
				const size = this.sqlite
					.prepare("SELECT length(CAST(data_json AS BLOB)) AS bytes FROM day_state WHERE id=1")
					.get() as { bytes: number } | undefined;
				if (!size) return null;
				if (size.bytes > MAX_DAY_STATE_BYTES) throw new Error("Storage limit");
				const row = this.sqlite
					.prepare("SELECT sequence,data_json FROM day_state WHERE id=1")
					.get() as { sequence: number; data_json: string };
				const state = parseDayState(JSON.parse(row.data_json));
				if (state.sequence !== row.sequence) throw new Error("Sequence mismatch");
				return state;
			})();
		} catch {
			throw new Error(STORED);
		}
	}
	async saveState(input: DayState, expectedSequence: number): Promise<void> {
		try {
			// Copy and validate before entering the transaction; queued callers cannot mutate saved bytes.
			const raw = JSON.stringify(input);
			if (Buffer.byteLength(raw) > MAX_DAY_STATE_BYTES) throw new Error("Storage limit");
			const state = parseDayState(JSON.parse(raw));
			const json = JSON.stringify(state);
			if (Buffer.byteLength(json) > MAX_DAY_STATE_BYTES || state.sequence !== expectedSequence + 1)
				throw new Error("Sequence mismatch");
			this.sqlite.transaction(() => {
				const current = this.sqlite.prepare("SELECT sequence FROM day_state WHERE id=1").get() as
					| { sequence: number }
					| undefined;
				if ((current?.sequence ?? 0) !== expectedSequence) throw new Error("Concurrent day writer");
				this.sqlite
					.prepare(
						"INSERT INTO day_state(id,sequence,data_json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence,data_json=excluded.data_json"
					)
					.run(state.sequence, json);
			})();
		} catch {
			throw new Error(INPUT);
		}
	}
}
