import type { z } from "zod";
import type { ApprovalPolicy, ApprovalPresentationSchema } from "../../shared/contracts";

type Presentation = z.infer<typeof ApprovalPresentationSchema>;

/** UI ownership only. Confirmation authority stays entirely in main. */
export class ApprovalDialogLifecycle {
	private mode: "closed" | "manual" | "automatic" = "closed";
	private proposal: (Presentation & { headSha: string; connectionId: string }) | null = null;

	manual() {
		this.mode = "manual";
		this.proposal = null;
	}
	close() {
		this.mode = "closed";
		this.proposal = null;
	}
	observe(pending: Presentation | null, policies: ApprovalPolicy[], canOpen: boolean) {
		if (this.mode === "manual") return null;
		if (pending && canOpen) {
			const policy = policies.find(
				(p) => p.id === pending.id && p.revision === pending.revision && p.digest === pending.digest
			);
			if (policy?.status === "draft" && policy.confirmedAt === null) {
				this.mode = "automatic";
				this.proposal = {
					...pending,
					headSha: policy.pr.headSha,
					connectionId: policy.connectionId,
				};
				return { kind: "open" as const, id: policy.id };
			}
		}
		const proposal = this.proposal;
		if (!proposal || pending) return null;
		const confirmed = policies.find(
			(p) =>
				p.id === proposal.id &&
				p.revision === proposal.revision &&
				p.digest === proposal.digest &&
				p.pr.headSha === proposal.headSha &&
				p.connectionId === proposal.connectionId &&
				p.confirmedAt !== null &&
				["monitoring", "notified", "submitting", "approved"].includes(p.status)
		);
		if (!confirmed) return null;
		this.close();
		return { kind: "close" as const };
	}
}
