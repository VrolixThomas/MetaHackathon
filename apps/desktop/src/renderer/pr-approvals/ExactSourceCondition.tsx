import type { ApprovalTerms } from "../../shared/contracts";

export function ExactSourceCondition({
	condition: c,
}: {
	condition: Extract<ApprovalTerms["conditions"][number], { kind: "source" }>;
}) {
	return (
		<>
			<span>
				{c.path}: {c.reason}
			</span>
			<details>
				<summary>
					Inspect exact complete source ({new TextEncoder().encode(c.expectedContent).byteLength}{" "}
					UTF-8 bytes)
				</summary>
				<pre>{c.expectedContent}</pre>
			</details>
		</>
	);
}
