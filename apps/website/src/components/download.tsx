import { RELEASES_URL, REPOSITORY_URL, type ReleaseState } from "@/lib/releases";
import { Icon } from "./icons";

export function DownloadButton({ release }: { release: ReleaseState }) {
	const download =
		release.status === "ready" && release.downloads.length === 1 ? release.downloads[0] : undefined;
	return (
		<a className="button primary" href={download?.url ?? "#download"}>
			{download ? "Download for macOS" : "Get MuseFocus"} <Icon name="download" />
		</a>
	);
}

export function Downloads({ release }: { release: ReleaseState }) {
	const downloads = release.status === "ready" ? release.downloads : [];
	return (
		<div className="downloads">
			{downloads.length > 0 ? (
				<>
					<p className="release-status">
						Latest release · {release.status === "ready" && release.version}
					</p>
					<div className="download-options">
						{downloads.map((download) => (
							<div className="download-option" key={download.name}>
								<a className="button primary" href={download.url}>
									<Icon name="download" /> Download for {download.platform}
								</a>
								<span>macOS · DMG · {Math.ceil(download.size / 1024 / 1024)} MB</span>
							</div>
						))}
					</div>
				</>
			) : (
				<p className="release-status">
					{release.status === "unpublished"
						? "The first macOS release is coming soon. Follow along on GitHub."
						: release.status === "ready"
							? "A macOS installer isn’t attached to the latest release yet. Check the release notes for availability."
							: "We couldn’t check the latest download right now. You can find releases on GitHub."}
				</p>
			)}
			<div className="release-links">
				<a className="text-link" href={release.status === "ready" ? release.url : RELEASES_URL}>
					{release.status === "ready" ? "Release notes" : "View releases"}{" "}
					<Icon name="arrow" size={15} />
				</a>
				<a className="text-link" href={REPOSITORY_URL}>
					<Icon name="github" size={17} /> View on GitHub
				</a>
			</div>
		</div>
	);
}
