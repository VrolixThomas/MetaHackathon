export const REPOSITORY_URL = "https://github.com/VrolixThomas/MuseFocus";
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;

export type ReleaseDownload = {
	name: string;
	url: string;
	platform: string;
	size: number;
};
export type ReleaseState =
	| { status: "ready"; version: string; url: string; downloads: ReleaseDownload[] }
	| { status: "unpublished" | "unavailable" };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function parseRelease(value: unknown): ReleaseState {
	if (
		!record(value) ||
		value["draft"] !== false ||
		value["prerelease"] !== false ||
		typeof value["tag_name"] !== "string" ||
		!Array.isArray(value["assets"])
	) {
		return { status: "unavailable" };
	}
	const downloads: ReleaseDownload[] = [];
	for (const asset of value["assets"]) {
		if (
			!record(asset) ||
			typeof asset["name"] !== "string" ||
			!/^MuseFocus-.+-(arm64|x64|universal)\.dmg$/i.test(asset["name"]) ||
			/unsigned|local/i.test(asset["name"]) ||
			typeof asset["browser_download_url"] !== "string" ||
			typeof asset["size"] !== "number" ||
			!Number.isFinite(asset["size"]) ||
			asset["size"] <= 0 ||
			asset["state"] !== "uploaded"
		) {
			continue;
		}
		try {
			const url = new URL(asset["browser_download_url"]);
			const expected = `${REPOSITORY_URL}/releases/download/${encodeURIComponent(value["tag_name"])}/${encodeURIComponent(asset["name"])}`;
			if (url.href !== expected) continue;
			downloads.push({
				name: asset["name"],
				url: url.href,
				platform: /-arm64\.dmg$/i.test(asset["name"])
					? "Apple Silicon"
					: /-x64\.dmg$/i.test(asset["name"])
						? "Intel"
						: "Apple Silicon & Intel",
				size: asset["size"],
			});
		} catch {
			// Ignore malformed asset URLs; the release page remains available.
		}
	}
	return {
		status: "ready",
		version: value["tag_name"],
		url: `${RELEASES_URL}/tag/${encodeURIComponent(value["tag_name"])}`,
		downloads,
	};
}
