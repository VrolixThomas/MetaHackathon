import { z } from "zod";

export const SlackIdSchema = z
	.string()
	.min(2)
	.max(100)
	.regex(/^[A-Z][A-Z0-9]+$/);
export const SlackTsSchema = z
	.string()
	.max(30)
	.regex(/^\d{1,16}\.\d{6}$/);
export const SlackTokenSchema = z
	.string()
	.min(1)
	.max(16384)
	.regex(/^[\x21-\x7e]+$/);
export const SlackScopesSchema = z
	.array(
		z
			.string()
			.min(1)
			.max(100)
			.regex(/^[\w:.-]+$/)
	)
	.max(100);

/** Main-only. Root owns environment access, encryption, refresh single-flight and account fencing. */
export const SlackCredentialSchema = z.strictObject({
	connectionId: z.string().min(1).max(200),
	accessToken: SlackTokenSchema,
	tokenKind: z.literal("user"),
	workspaceId: SlackIdSchema,
	userId: SlackIdSchema,
	appId: SlackIdSchema,
	scopes: SlackScopesSchema,
});
export type SlackCredential = z.infer<typeof SlackCredentialSchema>;
export type SlackErrorCode =
	| "connection-required"
	| "cancelled"
	| "provider"
	| "invalid-data"
	| "access-denied"
	| "missing-scope"
	| "rate-limited"
	| "stale-connection"
	| "uncertain-delivery"
	| "request-conflict"
	| "capacity";
const messages: Record<SlackErrorCode, string> = {
	"connection-required": "Connect a Slack user account to continue.",
	cancelled: "Slack operation cancelled or timed out.",
	provider: "Slack could not complete the request.",
	"invalid-data": "Slack returned invalid or oversized data.",
	"access-denied": "The connected Slack account cannot access this conversation.",
	"missing-scope": "Reconnect Slack with the required permissions.",
	"rate-limited": "Slack is rate limited; retry after the indicated delay.",
	"stale-connection": "The Slack account changed during this operation.",
	"uncertain-delivery": "Slack delivery is uncertain; reconcile before attempting another send.",
	"request-conflict": "This Slack request ID already identifies another reply.",
	capacity: "The bounded Slack operation capacity was reached.",
};
/** No provider text, token, URL, request body or cause is attached to public-safe failures. */
export class SlackError extends Error {
	constructor(
		readonly code: SlackErrorCode,
		readonly retryAfterSeconds?: number
	) {
		super(messages[code]);
		this.name = "SlackError";
	}
}

export function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (!result.success) throw new SlackError("invalid-data");
	return result.data;
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new SlackError("cancelled"));
		if (signal.aborted) {
			void work.catch(() => {});
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export function compareTs(a: string, b: string): number {
	const parts = (value: string) => BigInt(value.replace(".", ""));
	return parts(a) < parts(b) ? -1 : parts(a) > parts(b) ? 1 : 0;
}
