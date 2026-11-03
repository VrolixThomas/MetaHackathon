import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ReceiptSchema } from "./types";
const Entry = z.strictObject({
	key: z.string(),
	phase: z.enum(["publishing", "readying", "requesting", "sent"]),
	receipt: ReceiptSchema.nullable(),
});
export type ReviewRequestEntry = z.infer<typeof Entry>;
export const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** One app-owned instance per private profile. Exclusive create admits before any side effect.
 * Interrupted phases are deliberately never automatically replayed. */
export class ReviewRequestLedger {
	constructor(private readonly directory: string) {}
	private path(key: string) {
		return join(this.directory, `${digest(key)}.json`);
	}
	async read(key: string): Promise<ReviewRequestEntry | null> {
		let file: Awaited<ReturnType<typeof open>>;
		try {
			file = await open(this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		try {
			const result = Entry.parse(JSON.parse(await file.readFile("utf8")));
			if (result.key !== key) throw new Error("Invalid ledger");
			return result;
		} finally {
			await file.close();
		}
	}
	async admit(key: string): Promise<boolean> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		let file: Awaited<ReturnType<typeof open>>;
		try {
			file = await open(this.path(key), "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
		try {
			await file.writeFile(JSON.stringify({ key, phase: "publishing", receipt: null }));
			await file.sync();
		} finally {
			await file.close();
		}
		await this.sync();
		return true;
	}
	async write(entry: ReviewRequestEntry) {
		const target = this.path(entry.key);
		const temporary = `${target}.${randomUUID()}`;
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify(Entry.parse(entry)));
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, target);
		await this.sync();
	}
	private async sync() {
		const dir = await open(this.directory, "r");
		try {
			await dir.sync();
		} finally {
			await dir.close();
		}
	}
}
