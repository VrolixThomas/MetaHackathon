# Three minute demo script

MET-43 / E-1. Target runtime: 180 seconds, including live agent speech and pauses.
Read only the Narration column aloud; bracketed directions are production instructions.
Rehearse against the integrated app before recording. The final take must show actual
hackathon work and must not present fixture output as a live execution.

| Time | Screen and action | Narration |
| --- | --- | --- |
| 0:00–0:18 | Open shop-web review. Keep the diff, sidebar and transcript visible. | “A pull request tells you what changed. Reviewing it means discovering why it changed, what it affects, and whether it works. MetaHackathon brings those questions into one review workspace, with voice keeping you close to the code.” |
| 0:18–0:38 | Expand the PR in the sidebar. Select pricing, then cartReminder. | “The sidebar gives us a reading route through the change. We can see which files still need attention and return to a location without losing the review. This pull request changes how promotions and loyalty discounts combine.” |
| 0:38–1:03 | Open Why lens. Show a recorded source, then an inferred note. Hold Space, ask, release. Leave 7 seconds for the real answer. | “The Why lens separates recorded author intent from the agent’s interpretation. Each explanation keeps its source. I can ask about the code I am looking at.” **Spoken request:** “What is this change for?” |
| 1:03–1:38 | Hold Space, ask, release. Show immediate acknowledgement, actual base/head scenario results and synchronized throw-line highlight. Leave 12 seconds for execution and agent speech. | **Spoken request:** “Show me scenario C.” “This scenario checks an expired promotion in the reminder batch. Before the change, the batch reaches the next cart. After the change, PromoExpiredError stops it. We can follow that result straight back to the code.” |
| 1:38–2:03 | Open actual phone preview. Select the discount cap marker and its code location. | “The phone preview gives the change a visible consequence. Here is the discount cap in the checkout, connected to its implementation. We can move between the result and the code instead of reconstructing the behavior from a diff alone.” |
| 2:03–2:32 | Ask for a draft. Show original words and editable draft; revise it. If the agent is speaking, press Space and show it stops. | **Spoken request:** “Draft a review comment about the expired promotion stopping the reminder batch.” “The agent drafts my concern. I can interrupt the response, edit the wording, and check the evidence. Drafting does not post anything.” |
| 2:32–2:50 | Open sign-off. Show explicit confirmation with exact draft body/head. Only actually post to an approved demo PR. Otherwise leave confirmation visible. | “Sign-off keeps the decision with the reviewer. Posting requires an explicit confirmation of this exact comment on this revision. The review stays grounded in evidence, and the final judgment stays human.” |
| 2:50–3:00 | Return to review overview; end card with verified public repo and release/video URLs. | “That is MetaHackathon: ask in the context of the code, inspect the consequence, and leave a review you can explain.” |

## Timing and recording rules

The narration is 275 words, including spoken requests. At 145 words per minute,
allow about 114 seconds of speech and 66 seconds for agent audio, execution, transitions and
pauses. Rehearse with a stopwatch; trim narration if real provider latency uses the reserve.
Do not speed up the scenario run or edit away a failed result to imply success.

For a slow live request, keep the acknowledgement and working state visible, then use a
clearly disclosed cut if needed. Retake the complete sequence when practical. The three-minute
cut may shorten narration; it must retain sidebar, Why provenance, scenario C, phone preview
and sign-off. If any required path is not integrated, recording is blocked rather than staged.

Do not claim a GitHub post unless the recording shows a real submission and receipt. A
confirmation-screen-only ending must say “posting requires confirmation,” not “posted.”
No API keys, tokens, private notification popups or unrelated repository data should be in frame.
