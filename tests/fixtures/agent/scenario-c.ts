import type { PullRequest, ScenarioPlan } from "../../../apps/desktop/src/shared/contracts";

/** Generator acceptance input for MET-7's seeded repository. This is not a run result. */
export function expiredReminderPlan(pr: PullRequest): ScenarioPlan {
	return {
		id: "C",
		pr,
		title: "An expired promo must not stop the nightly reminder batch",
		origin: {
			kind: "reviewer",
			requestId: "scenario-c-acceptance",
			originalWords:
				"What happens if a promo expires before the nightly reminder? Keep it as a test.",
		},
		inputs: { expired: true, carts: 2 },
		modulePath: "jobs/cartReminder.ts",
		exportName: "cartReminder",
		anchor: "export function cartReminder(",
		arguments: [
			[
				{
					id: "abandoned-1",
					subtotal: 120,
					code: "SPRING15",
					shopper: { loyalty: { percent: 10 } },
				},
				{ id: "abandoned-2", subtotal: 80, shopper: { loyalty: { percent: 10 } } },
			],
			[],
			{ expired: true },
		],
		expectation: {
			path: ["arguments", 1, "length"],
			equals: 2,
			description: "Both carts should receive reminders even when the first promo expired",
		},
	};
}
