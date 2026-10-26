// Set launch.json only after checking the recorded video and published signed release.
fetch("launch.json")
	.then((response) => {
		if (!response.ok) throw new Error("Launch metadata unavailable");
		return response.json();
	})
	.then((launch) => {
		if (launch.releaseReady === true) {
			document.querySelector("#download").textContent = "Download for macOS ↗";
			document.querySelector("#release-status").textContent =
				"Get the signed app from the latest GitHub release.";
		} else if (launch.repositoryPublic === true) {
			document.querySelector("#release-status").textContent =
				"Signed download pending. Explore the source while the release is prepared.";
		}
		if (typeof launch.videoUrl !== "string") return;
		const url = new URL(launch.videoUrl);
		if (url.protocol !== "https:") return;
		const panel = document.querySelector("#video-panel");
		const heading = document.createElement("h3");
		heading.textContent = "Watch the recorded demo";
		const link = document.createElement("a");
		link.href = url.href;
		link.textContent = "Open the three-minute video ↗";
		link.rel = "noopener noreferrer";
		panel.replaceChildren(heading, link);
	})
	.catch(() => {
		/* The default page accurately shows unpublished launch state. */
	});
