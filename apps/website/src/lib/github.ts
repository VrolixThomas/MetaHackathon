import { type ReleaseState, parseRelease } from "./releases";

export async function getLatestRelease(): Promise<ReleaseState> {
	try {
		const response = await fetch(
			"https://api.github.com/repos/VrolixThomas/MuseFocus/releases/latest",
			{
				headers: { Accept: "application/vnd.github+json" },
				next: { revalidate: 300 },
				signal: AbortSignal.timeout(5000),
			}
		);
		if (response.status === 404) return { status: "unpublished" };
		if (!response.ok) return { status: "unavailable" };
		return parseRelease(await response.json());
	} catch {
		return { status: "unavailable" };
	}
}
