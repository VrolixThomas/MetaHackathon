import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DownloadButton, Downloads } from "../components/download";
import { getLatestRelease } from "./github";
import { REPOSITORY_URL, parseRelease } from "./releases";

function asset(arch: string) {
	const name = `MuseFocus-1.2.3-${arch}.dmg`;
	return {
		name,
		browser_download_url: `${REPOSITORY_URL}/releases/download/v1.2.3/${name}`,
		size: 100 * 1024 * 1024,
		state: "uploaded",
	};
}
function release(assets: unknown[]) {
	return { tag_name: "v1.2.3", draft: false, prerelease: false, assets };
}

test("latest installers preserve architecture choices and actual release URLs", () => {
	const result = parseRelease(release([asset("arm64"), asset("x64")]));
	assert.equal(result.status, "ready");
	if (result.status !== "ready") return;
	assert.deepEqual(
		result.downloads.map((d) => d.platform),
		["Apple Silicon", "Intel"]
	);
	const html = renderToStaticMarkup(<Downloads release={result} />);
	assert.match(html, /Download for Apple Silicon/);
	assert.match(html, /Download for Intel/);
	assert.match(html, /100 MB/);
	assert(html.includes(asset("arm64").browser_download_url));
	assert.match(renderToStaticMarkup(<DownloadButton release={result} />), /href="#download"/);
	const single = parseRelease(release([asset("arm64")]));
	assert(
		renderToStaticMarkup(<DownloadButton release={single} />).includes(
			asset("arm64").browser_download_url
		)
	);
});

test("drafts, prereleases, foreign URLs and unfinished or unsigned assets are not download buttons", () => {
	assert.equal(parseRelease({ ...release([]), draft: true }).status, "unavailable");
	assert.equal(parseRelease({ ...release([]), prerelease: true }).status, "unavailable");
	const result = parseRelease(
		release([
			{ ...asset("arm64"), browser_download_url: "https://example.com/installer.dmg" },
			{ ...asset("arm64"), state: "new" },
			{ ...asset("arm64"), size: 0 },
			asset("arm64-UNSIGNED-LOCAL"),
			{ ...asset("arm64"), name: "source.zip" },
		])
	);
	assert.equal(result.status, "ready");
	if (result.status === "ready") assert.deepEqual(result.downloads, []);
	assert.match(renderToStaticMarkup(<Downloads release={result} />), /isn’t attached/);
});

test("missing releases and GitHub failures have honest, usable fallbacks", async () => {
	const originalFetch = globalThis.fetch;
	try {
		for (const [status, expected] of [
			[404, "unpublished"],
			[403, "unavailable"],
			[500, "unavailable"],
		] as const) {
			globalThis.fetch = (async () => new Response(null, { status })) as typeof fetch;
			assert.equal((await getLatestRelease()).status, expected);
		}
		globalThis.fetch = (async () => {
			throw new Error("network unavailable");
		}) as typeof fetch;
		assert.equal((await getLatestRelease()).status, "unavailable");
		globalThis.fetch = (async () => Response.json(release([asset("arm64")]))) as typeof fetch;
		assert.equal((await getLatestRelease()).status, "ready");
	} finally {
		globalThis.fetch = originalFetch;
	}
	const html = renderToStaticMarkup(<Downloads release={{ status: "unpublished" }} />);
	assert.match(html, /first macOS release is coming soon/);
	assert(html.includes(`${REPOSITORY_URL}/releases`));
	assert(!html.includes("/releases/latest"));
	assert(!html.includes(".dmg"));
});

// GitHub returns canonical asset URLs after a repository rename, even when the
// API lookup follows a redirect from the former repository name.
test("canonical MuseFocus release installers remain downloadable after the repository rename", () => {
	const result = parseRelease({
		tag_name: "v0.1.3",
		draft: false,
		prerelease: false,
		assets: [
			{
				name: "MuseFocus-0.1.3-arm64.dmg",
				state: "uploaded",
				size: 259594917,
				browser_download_url:
					"https://github.com/VrolixThomas/MuseFocus/releases/download/v0.1.3/MuseFocus-0.1.3-arm64.dmg",
			},
		],
	});
	assert.equal(result.status, "ready");
	if (result.status !== "ready") return;
	assert.equal(result.downloads.length, 1);
	assert.match(renderToStaticMarkup(<Downloads release={result} />), /Download for Apple Silicon/);
});
