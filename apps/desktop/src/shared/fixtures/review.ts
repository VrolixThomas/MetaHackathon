import { z } from "zod";
import {
	AgentActionSchema,
	AgentTurnInputSchema,
	CONTRACT_VERSION,
	CancelTurnInputSchema,
	CodeLocationSchema,
	ConfirmCommentInputSchema,
	DiagramSpecSchema,
	DraftedCommentSchema,
	FixtureEvidenceSchema,
	PRPreparationSchema,
	PreviewSchema,
	ScenarioTraceSchema,
	ScreenContextSchema,
	VoiceStateSchema,
} from "../contracts";

export const DEMO_FIXTURE_ID = "shop-web-promo-v1";
const baseSha = "1".repeat(40);
const headSha = "2".repeat(40);
const prId = "demo/shop-web#1284";
const evidence = {
	kind: "fixture" as const,
	fixtureId: DEMO_FIXTURE_ID,
	label: "Illustrative fixture — no repository, scenario, preview or voice execution occurred",
};

export const ReviewFixtureSchema = z.strictObject({
	contractVersion: z.literal(CONTRACT_VERSION),
	id: z.literal(DEMO_FIXTURE_ID),
	evidence: FixtureEvidenceSchema,
	preparation: PRPreparationSchema,
	screenContext: ScreenContextSchema,
	agentTurn: AgentTurnInputSchema,
	actions: z.array(AgentActionSchema),
	scenario: ScenarioTraceSchema,
	diagram: DiagramSpecSchema,
	preview: PreviewSchema,
	draftComment: DraftedCommentSchema,
	confirmation: ConfirmCommentInputSchema,
	voiceState: VoiceStateSchema,
	cancellation: CancelTurnInputSchema,
});
export type ReviewFixture = z.infer<typeof ReviewFixtureSchema>;

function location(revision: "base" | "head", path: string, startLine: number, endLine = startLine) {
	return CodeLocationSchema.parse({
		repository: "demo/shop-web",
		revision,
		commitSha: revision === "base" ? baseSha : headSha,
		path,
		startLine,
		endLine,
	});
}

// Fresh parsed objects on every call; no clock, random IDs, I/O or mutation shared with callers.
export function getReviewFixture(): ReviewFixture {
	const turnIdentity = { sessionId: "voice-fixture", turnId: "turn-1", generation: 1 };
	const rule = (revision: "base" | "head", line: number) =>
		location(revision, "pricing/applyDiscounts.ts", line);
	const reminder = (revision: "base" | "head", line: number) =>
		location(revision, "jobs/cartReminder.ts", line);
	const screenContext = {
		prId,
		sequence: 4,
		panel: "scenario",
		focusedLocation: rule("head", 12),
		artifactId: "scenario-c",
		scenarioStepId: "head-4",
	};
	const draft = {
		id: "draft-expired-code",
		prId,
		revision: 1,
		headSha,
		originalWords: "Ask Noor to keep expired codes from stopping the nightly reminders.",
		body: "Could we ignore expired codes here? Throwing PromoExpiredError stops the nightly reminder batch, so later carts receive no reminder.",
		location: rule("head", 12),
		evidence,
	};
	const steps = (revision: "base" | "head") => [
		{
			id: `${revision}-1`,
			label: "Price an abandoned cart",
			location: reminder(revision, 44),
			values: { subtotalCents: 12000, code: "SPRING15" },
			outcome: "continue",
		},
		{
			id: `${revision}-2`,
			label: "Read loyalty discount",
			location: rule(revision, 8),
			values: { loyaltyPercent: 10 },
			outcome: "continue",
		},
		{
			id: `${revision}-3`,
			label: "Load expired promo",
			location: rule(revision, 11),
			values: { code: "SPRING15", expired: true },
			outcome: "continue",
		},
		{
			id: `${revision}-4`,
			label: revision === "base" ? "Skip expired code" : "Throw PromoExpiredError",
			location: rule(revision, 12),
			values: revision === "base" ? { totalCents: 10800 } : { error: "PromoExpiredError" },
			outcome: revision === "base" ? "return" : "throw",
		},
		{
			id: `${revision}-5`,
			label: revision === "base" ? "Send reminder" : "Batch stops; later carts get no reminder",
			location: reminder(revision, revision === "base" ? 45 : 44),
			values: { reminderSent: revision === "base" },
			outcome: revision === "base" ? "return" : "stopped",
		},
	];
	return ReviewFixtureSchema.parse({
		contractVersion: CONTRACT_VERSION,
		id: DEMO_FIXTURE_ID,
		evidence,
		preparation: {
			contractVersion: CONTRACT_VERSION,
			pr: {
				id: prId,
				repository: "demo/shop-web",
				number: 1284,
				url: "https://example.com/fixtures/shop-web/pull/1284",
				title: "Stackable promo codes at checkout",
				author: "Noor (fixture)",
				baseSha,
				headSha,
			},
			status: "ready",
			summary: "Stack loyalty and one promo code, capped at 40% of subtotal.",
			files: [
				{
					path: "pricing/applyDiscounts.ts",
					category: "needs-review",
					attention: "read",
					readingOrder: 0,
					reason: "Moves money and changes expired-code behavior",
					evidence,
				},
				{
					path: "orders/finalizeOrder.ts",
					category: "needs-review",
					attention: "read",
					readingOrder: 1,
					reason: "Locks the price and stores the applied promo code",
					evidence,
				},
				{
					path: "migrations/0047_order_promo.sql",
					category: "needs-review",
					attention: "skim",
					readingOrder: 2,
					reason: "Adds orders.promo_code, read by finance-service #412",
					evidence,
				},
				{
					path: "checkout/PromoField.tsx",
					category: "needs-review",
					attention: "preview",
					readingOrder: 3,
					reason: "Check the cap note on a phone",
					evidence,
				},
				{
					path: "promo/PromoCache.ts",
					category: "needs-review",
					attention: "decide",
					readingOrder: 4,
					reason: "Cache not requested by the ticket or author intent",
					evidence,
				},
				{
					path: "types/Order.ts",
					category: "mechanical-candidate",
					attention: "skim",
					readingOrder: 5,
					reason: "Candidate only; both builds have not been executed",
					evidence,
				},
			],
			whyNotes: [
				{
					id: "why-stacking",
					location: { ...rule("head", 14), endLine: 17 },
					text: "SHOP-482 asks for stacking with a 40% cap.",
					evidence,
					provenance: {
						kind: "recorded",
						sources: [
							{
								kind: "ticket",
								url: "https://example.com/fixtures/SHOP-482",
								excerpt: "Loyalty and promo should stack, total capped at 40%.",
								evidence,
							},
						],
					},
				},
				{
					id: "why-expired",
					location: rule("head", 12),
					text: "This throw may stop the nightly reminder batch.",
					evidence,
					provenance: {
						kind: "inferred",
						explanation: "The illustrated caller has no catch; not an executed result.",
						sources: [],
					},
				},
			],
			evidence,
		},
		screenContext,
		agentTurn: {
			requestId: "question-c",
			...turnIdentity,
			text: "Show me scenario C",
			screenContext,
		},
		actions: [
			{
				requestId: "action-show-c",
				...turnIdentity,
				screenSequence: 4,
				kind: "show-scenario",
				scenarioId: "scenario-c",
			},
			{
				requestId: "action-highlight",
				...turnIdentity,
				screenSequence: 4,
				kind: "highlight-code",
				location: rule("head", 12),
				note: "Paths split here",
			},
			{
				requestId: "action-preview",
				...turnIdentity,
				screenSequence: 4,
				kind: "show-preview",
				previewId: "preview-phone",
			},
			{
				requestId: "action-draft",
				...turnIdentity,
				screenSequence: 4,
				kind: "draft-comment",
				draft,
			},
		],
		scenario: {
			id: "scenario-c",
			prId,
			title: "C: expired promo in nightly cart reminders",
			inputs: { subtotalCents: 12000, loyaltyPercent: 10, code: "SPRING15", expired: true },
			before: {
				revision: "base",
				commitSha: baseSha,
				status: "completed",
				steps: steps("base"),
				evidence,
			},
			after: {
				revision: "head",
				commitSha: headSha,
				status: "completed",
				steps: steps("head"),
				evidence,
			},
			divergenceIndex: 3,
		},
		diagram: {
			id: "diagram-callers",
			prId,
			title: "Nightly reminder calls the discount rule",
			nodes: [
				{ id: "reminder", label: "Nightly reminder", location: reminder("head", 44) },
				{ id: "discount", label: "Discount rule", location: rule("head", 7) },
			],
			edges: [{ from: "reminder", to: "discount", label: "calls" }],
			evidence,
		},
		preview: {
			id: "preview-phone",
			prId,
			revision: "head",
			commitSha: headSha,
			url: "http://localhost:3000/checkout?fixture=cap",
			viewport: { mode: "phone", width: 390, height: 844 },
			markers: [
				{
					id: "cap-note",
					number: 1,
					label: "40% cap note wraps on a phone",
					location: location("head", "checkout/PromoField.tsx", 10, 12),
					bounds: { x: 24, y: 280, width: 240, height: 48 },
				},
				{
					id: "pay",
					number: 2,
					label: "Pay is below the fold",
					location: location("head", "checkout/PromoField.tsx", 16),
					bounds: { x: 24, y: 900, width: 342, height: 48 },
				},
			],
			evidence,
		},
		draftComment: draft,
		// Sample payload only. The fixture router provides no posting procedure.
		confirmation: {
			requestId: "confirm-fixture",
			draftId: draft.id,
			draftRevision: draft.revision,
			headSha,
			body: draft.body,
			confirmed: true,
		},
		voiceState: {
			sessionId: "voice-fixture",
			turnId: "turn-1",
			generation: 1,
			phase: "listening",
			transcript: "Show me scenario C",
			transcriptFinal: true,
		},
		cancellation: {
			requestId: "cancel-fixture",
			sessionId: "voice-fixture",
			turnId: "turn-1",
			generation: 1,
			reason: "push-to-talk",
		},
	});
}
