/** Best-effort credential filtering, not a secret scanner or an OS security boundary. */
export function redactCodingText(text: string, secrets: readonly string[] = []): string {
	let safe = text;
	const known = [
		...secrets,
		...Object.entries(process.env)
			.filter(([key]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(key))
			.map(([, value]) => value ?? ""),
	].filter((value) => value.length >= 6);
	for (const value of known) safe = safe.split(value).join("[REDACTED]");
	return safe
		.replace(
			/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
			"[REDACTED PRIVATE KEY]"
		)
		.replace(
			/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g,
			"[REDACTED]"
		)
		.replace(/(\b(?:authorization\s*[:=]\s*["']?bearer)\s+)[^\s"']+/gi, "$1[REDACTED]")
		.replace(
			/((?:["']?)[A-Za-z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PRIVATE_KEY|CLIENT_SECRET)(?:["']?)\s*[:=]\s*)(["'])([^\r\n]*?)\2/gi,
			"$1$2[REDACTED]$2"
		)
		.replace(
			/(\b[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PRIVATE_KEY|CLIENT_SECRET)\s*=\s*)([^\s"'\r\n]+)/g,
			"$1[REDACTED]"
		);
}

/** All log/checkpoint/provider payloads pass through the same recursive filter. */
export function redactCodingValue<T>(value: T, redact: (text: string) => string): T {
	if (typeof value === "string") return redact(value) as T;
	if (Array.isArray(value)) return value.map((item) => redactCodingValue(item, redact)) as T;
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, redactCodingValue(item, redact)])
		) as T;
	}
	return value;
}

export class CodingToolError extends Error {
	constructor(
		readonly code: string,
		message: string
	) {
		super(message);
		this.name = "CodingToolError";
	}
}
