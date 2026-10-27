# Landing site

Static, dependency-free landing page for MET-35. Serve this directory with any static host.
Local preview: `python3 -m http.server 4175 --bind 127.0.0.1 --directory apps/site`.

`launch.json` starts with no video and no released app. After E-2 has an actual recorded,
reviewed video, set its HTTPS URL. Set `releaseReady` only after runtime verifies the signed,
notarized GitHub release and the latest-release link. Set `repositoryPublic` after MET-6
changes repository visibility. The homepage labels example content and pending assets.
No provider keys, analytics, account connection, build tools or shared manifest changes.

Publication is pending the actual video, signed release and public-repository handoff.
Do not publish this staging state as a completed C-8 launch. The deployment destination
can be selected by integration when launch assets are ready; this commit is the repo source.
