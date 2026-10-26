import type Database from "better-sqlite3";

export interface SubmissionLedger {
	reserve(requestId: string, signature: string): { id: number; url: string } | undefined;
	complete(requestId: string, result: { id: number; url: string }): void;
}

/** Durable deduplication: an ambiguous write is never automatically repeated after restart. */
export class RuntimeState implements SubmissionLedger {
	constructor(private readonly sqlite: Database.Database) {
		sqlite.exec(`
			CREATE TABLE IF NOT EXISTS runtime_submissions (
				request_id TEXT PRIMARY KEY, signature TEXT NOT NULL, result_json TEXT
			);
			CREATE TABLE IF NOT EXISTS runtime_budgets (
				budget_key TEXT PRIMARY KEY, runs INTEGER NOT NULL, reserved_micros INTEGER NOT NULL
			);
		`);
	}

	reserve(requestId: string, signature: string) {
		return this.sqlite.transaction(() => {
			const row = this.sqlite
				.prepare("SELECT signature, result_json FROM runtime_submissions WHERE request_id = ?")
				.get(requestId) as { signature: string; result_json: string | null } | undefined;
			if (row) {
				if (row.signature !== signature)
					throw new Error("Confirmation request ID reused with different content");
				if (!row.result_json)
					throw new Error(
						"Previous GitHub write is pending or ambiguous; inspect GitHub before creating a new confirmation"
					);
				return JSON.parse(row.result_json) as { id: number; url: string };
			}
			this.sqlite
				.prepare("INSERT INTO runtime_submissions (request_id, signature) VALUES (?, ?)")
				.run(requestId, signature);
			return undefined;
		})();
	}

	complete(requestId: string, result: { id: number; url: string }) {
		this.sqlite
			.prepare("UPDATE runtime_submissions SET result_json = ? WHERE request_id = ?")
			.run(JSON.stringify(result), requestId);
	}

	reserveBudget(
		key: string,
		limits: { maxRuns: number; maxCostMicros: number },
		costMicros: number
	) {
		if (
			![limits.maxRuns, limits.maxCostMicros, costMicros].every(
				(value) => Number.isSafeInteger(value) && value >= 0
			)
		)
			throw new Error("Invalid budget limits");
		return this.sqlite.transaction(() => {
			const previous = this.sqlite
				.prepare("SELECT runs, reserved_micros FROM runtime_budgets WHERE budget_key = ?")
				.get(key) as { runs: number; reserved_micros: number } | undefined;
			const runs = (previous?.runs ?? 0) + 1;
			const reservedMicros = (previous?.reserved_micros ?? 0) + costMicros;
			if (runs > limits.maxRuns || reservedMicros > limits.maxCostMicros) return false;
			this.sqlite
				.prepare(
					"INSERT INTO runtime_budgets (budget_key, runs, reserved_micros) VALUES (?, ?, ?) ON CONFLICT(budget_key) DO UPDATE SET runs=excluded.runs, reserved_micros=excluded.reserved_micros"
				)
				.run(key, runs, reservedMicros);
			return true;
		})();
	}
}
