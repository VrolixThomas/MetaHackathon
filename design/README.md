# PR review workspace design

An interactive design exploration for a review workspace, styled after Macro's public app.
Agent responses, voice transcripts, patches, and verification results in the mockup are simulated.

Open `preview.html` in a browser, or serve this directory:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory design
```

Then open <http://127.0.0.1:4173/preview.html>.

- `pr-review-workspace.html`: editable interactive source fragment.
- `preview.html`: standalone rendered preview with its presentation runtime embedded.
- `trace-macro.css` and `trace-navigation.html`: source styling and navigation used in the fragment.
- `pr-review-workspace-v1.html`: the earlier visual direction.
- `pr-review-flow.drawio`: editable review workflow.
- `prototype-scaffold/`: the initial, incomplete React/TypeScript scaffold, preserved separately from the Electron workspace. Its original package configuration is included; it is not connected to the desktop app.

The scaffold's review-state checks can run without installing its dependencies:

```sh
node --experimental-strip-types --test design/prototype-scaffold/src/review.test.ts
```

This exploration began on October 26, 2026, before the participant guide's October 27 build start. It should be identified as pre-event work when documenting hackathon contributions.
