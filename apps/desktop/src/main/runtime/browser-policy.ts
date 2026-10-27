/** A browser may reach only the exact loopback origin supplied by its owned preview lease. */
export function previewOrigin(url: string): string {
	const target = new URL(url);
	if (
		target.protocol !== "http:" ||
		target.hostname !== "127.0.0.1" ||
		!target.port ||
		target.username ||
		target.password
	)
		throw new Error("Browser requires an owned loopback preview");
	return target.origin;
}

export function allowedBrowserURL(url: string, origin: string): boolean {
	try {
		const target = new URL(url);
		return (
			target.origin === origin &&
			target.protocol === "http:" &&
			!target.username &&
			!target.password
		);
	} catch {
		return false;
	}
}

export function browserURL(url: string, base: string): string {
	const resolved = new URL(url, base);
	if (!allowedBrowserURL(resolved.href, previewOrigin(base)))
		throw new Error("Navigation outside the active preview is blocked");
	// The owned demo server requires its run token on all routes, including a requested path.
	const runId = new URL(base).searchParams.get("runId");
	if (runId && !resolved.searchParams.has("runId")) resolved.searchParams.set("runId", runId);
	return resolved.href;
}
