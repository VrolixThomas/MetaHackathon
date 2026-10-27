/** Receipt failures must not be silently retried as browser/model operations. */
export class ActionReceiptError extends Error {
	constructor(readonly reason: "ignored" | "timeout" | "failed") {
		super(`Agent action receipt ${reason}`);
		this.name = "ActionReceiptError";
	}
}
