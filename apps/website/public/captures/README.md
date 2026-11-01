# Actual MuseFocus captures

Original native-window JPEG screenshots, 2880×1920, captured through the computer-use
app screenshot API from the real desktop build in `demo-story` at `901629a`.
No pixels, controls, text or outcomes were reconstructed or composited.

Launcher: `node scripts/demo-story/launch.cjs --scene=planning`.
Run ID: `0530efac-02bb-4bfe-b66a-e9294a2d503a`.
Scene selection used the provided `scripts/demo-story/scene.cjs` controller.

| Website asset | Actual selected scene |
| --- | --- |
| planning.jpg | `decision`: saved MET-77 storage-lifetime question |
| review.jpg | `review`: PR #1 source diff and inferred reading order |
| flow.jpg | `flow`: source-flow canvas at HTTP entry |
| fix.jpg | `fix`, scrolled to proposed diff and actual local test/build receipts |
| approval.jpg | `approval`: policy draft, consent unchecked |
| slack.jpg | `slack`: My day overview and proposed clarification status |

The initial `planning` conversation returned a review explanation instead of the
intended scope question. The published planning image therefore uses the provided
`decision` scene, where the intended question is visibly present in the actual app.

Inspecting Slack clarification details returned “The current thread could not be
authorized.” The website uses the earlier proposal overview, not a fabricated
expanded thread. No clarification or approval was confirmed, and no message sent.

All provider/model data is controlled. The proposed fix was authored by the setup;
its Git and test/build receipts are actual local execution. These captures do not
prove live speech, live providers, autonomous coding, approval or publication.
The website labels them as an illustrative walkthrough captured in MuseFocus with
prepared demo data. Raw window chrome and cursor indications are retained.
