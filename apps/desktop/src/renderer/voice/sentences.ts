/** Bounded, incremental speech chunks. It deliberately does not interpret user intent. */
export class Sentences {
	private pending = "";
	push(delta: string, final = false): string[] {
		this.pending += delta;
		const result: string[] = [];
		while (this.pending.length) {
			// A delta can end inside a decimal or before a closing quote. Wait for whitespace
			// or final=true instead of interpreting the temporary end of a token as a sentence.
			const boundary = /[.!?](?:["'”’)]*)\s+|\n/.exec(this.pending);
			let end = boundary ? boundary.index + boundary[0].length : 0;
			if ((!end || end > 1000) && this.pending.length >= 1000) {
				end = this.pending.lastIndexOf(" ", 1000);
				if (end < 1) end = 1000;
			}
			if (!end && final) end = this.pending.length;
			if (!end) break;
			const text = this.pending.slice(0, end).trim();
			this.pending = this.pending.slice(end);
			if (text) result.push(text);
		}
		return result;
	}
}
