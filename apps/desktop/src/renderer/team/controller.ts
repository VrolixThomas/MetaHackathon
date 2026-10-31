import type { z } from "zod";
import { createStore } from "zustand/vanilla";
import {
	ApplyTeamProposalSchema,
	CreateOrganizationSchema,
	DecideTeamProposalSchema,
	PreviewLocalProposalSchema,
	RegisterRepositorySchema,
	SelectScopeSchema,
	ShareLocalProposalSchema,
	type TeamApplyReceipt,
	TeamApplyReceiptSchema,
	TeamLocalPreviewSchema,
	TeamMutationResultSchema,
	TeamOrganizationSchema,
	TeamOrganizationsSchema,
	type TeamProposalDetail,
	TeamProposalDetailSchema,
	TeamProposalPageSchema,
	type TeamProposalSummary,
	TeamRepositoriesSchema,
	TeamRepositorySchema,
	TeamScopeSchema,
	type TeamStatus,
	TeamStatusSchema,
} from "../../../../../services/team/desktop-schemas";

export type TeamCall = (
	type: "query" | "mutation",
	path: string,
	input?: unknown
) => Promise<unknown>;
export interface TeamContext {
	repository?: string;
	prNumber?: number;
	candidateId?: string;
}
export interface TeamState {
	status: TeamStatus | null;
	organizations: z.infer<typeof TeamOrganizationSchema>[];
	repositories: z.infer<typeof TeamRepositorySchema>[];
	orgId: string | null;
	context: TeamContext;
	activeRepository: string | undefined;
	proposals: TeamProposalSummary[];
	nextOffset: number | null;
	nextRepositoryOffset: number | null;
	detail: TeamProposalDetail | null;
	preview: z.infer<typeof TeamLocalPreviewSchema> | null;
	applyReceipt: TeamApplyReceipt | null;
	busy: string | null;
	loading: boolean;
	error: string | null;
	notice: string | null;
}
const message = "Team request failed. Check the connection and repository access, then retry.";
/** Root owns one controller for the Settings card; all lists and exact sources come from main RPC. */
export function createTeamController(call: TeamCall) {
	const store = createStore<TeamState>(() => ({
		status: null,
		organizations: [],
		repositories: [],
		orgId: null,
		context: {},
		activeRepository: undefined,
		proposals: [],
		nextOffset: null,
		nextRepositoryOffset: null,
		detail: null,
		preview: null,
		applyReceipt: null,
		busy: null,
		loading: false,
		error: null,
		notice: null,
	}));
	let disposed = false;
	let started = false;
	let epoch = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let refreshing = false;
	const requests = new Map<string, string>();
	function request(key: string) {
		const existing = requests.get(key);
		if (existing) return existing;
		const id = crypto.randomUUID();
		requests.set(key, id);
		return id;
	}
	const live = (version: number) => !disposed && version === epoch;
	function schedule() {
		clearTimeout(timer);
		if (started && !disposed)
			timer = setTimeout(
				() => void refresh(),
				store.getState().status?.connection === "connecting" ? 1000 : 5000
			);
	}
	async function refresh() {
		if (disposed || refreshing) return;
		refreshing = true;
		const version = epoch;
		store.setState({ loading: true });
		try {
			const status = TeamStatusSchema.parse(await call("query", "team.status", {}));
			if (!live(version)) return;
			const previous = store.getState().status;
			if (previous?.userId !== status.userId) {
				epoch++;
				requests.clear();
				store.setState({
					organizations: [],
					repositories: [],
					orgId: null,
					proposals: [],
					detail: null,
					preview: null,
					applyReceipt: null,
				});
			}
			store.setState({ status, error: null });
			if (
				status.connection === "connected" &&
				(!store.getState().organizations.length || previous?.connection !== "connected")
			)
				await organizations();
		} catch {
			if (live(version)) store.setState({ error: message });
		} finally {
			refreshing = false;
			if (!disposed) {
				store.setState({ loading: false });
				schedule();
			}
		}
	}
	async function organizations() {
		const version = epoch;
		const result = TeamOrganizationsSchema.parse(await call("query", "team.organizations", {}));
		if (!live(version)) return;
		const state = store.getState();
		const scoped = state.status?.scopes.find(
			(scope) =>
				scope.repository.toLowerCase() ===
				(state.context.repository ?? state.activeRepository)?.toLowerCase()
		);
		const orgId =
			state.orgId && result.items.some((org) => org.id === state.orgId)
				? state.orgId
				: (scoped?.orgId ?? result.items[0]?.id ?? null);
		store.setState({ organizations: result.items, orgId });
		if (orgId) await repositories(orgId);
		if (state.activeRepository || state.context.repository) await proposals();
	}
	async function repositories(orgId: string, offset = 0) {
		const version = epoch;
		const result = TeamRepositoriesSchema.parse(
			await call("query", "team.repositories", { orgId, offset })
		);
		if (!live(version) || store.getState().orgId !== orgId) return;
		store.setState((state) => ({
			repositories: offset ? [...state.repositories, ...result.items] : result.items,
			nextRepositoryOffset: result.nextOffset,
		}));
	}
	async function proposals(offset = 0) {
		const state = store.getState();
		const repository = state.context.repository ?? state.activeRepository;
		if (
			!repository ||
			!state.status?.scopes.some(
				(scope) => scope.repository.toLowerCase() === repository.toLowerCase()
			)
		)
			return;
		const version = epoch;
		const result = TeamProposalPageSchema.parse(
			await call("query", "team.proposals", {
				repository,
				prNumber: state.context.prNumber,
				offset,
			})
		);
		if (!live(version)) return;
		store.setState((state) => ({
			proposals: offset ? [...state.proposals, ...result.items] : result.items,
			nextOffset: result.nextOffset,
		}));
	}
	async function run(label: string, operation: (version: number) => Promise<void>) {
		if (disposed || store.getState().busy) return;
		const version = epoch;
		store.setState({ busy: label, error: null, notice: null });
		try {
			await operation(version);
		} catch {
			if (live(version)) store.setState({ error: message });
		} finally {
			if (!disposed) store.setState({ busy: null });
		}
	}
	return {
		store,
		start() {
			if (started) return Promise.resolve();
			started = true;
			return refresh();
		},
		refresh,
		setContext(context: TeamContext) {
			const state = store.getState();
			if (JSON.stringify(state.context) === JSON.stringify(context)) return;
			epoch++;
			store.setState({
				context,
				activeRepository: context.repository ?? state.activeRepository,
				detail: null,
				preview: null,
				applyReceipt: null,
				proposals: [],
				error: null,
			});
			if (state.status?.connection === "connected")
				void run("loading", async () => {
					await proposals();
				});
		},
		login: () =>
			run("login", async (version) => {
				const status = TeamStatusSchema.parse(await call("mutation", "team.login", {}));
				if (live(version)) store.setState({ status });
				schedule();
			}),
		async logout() {
			epoch++;
			requests.clear();
			store.setState({
				busy: "logout",
				organizations: [],
				repositories: [],
				orgId: null,
				proposals: [],
				detail: null,
				preview: null,
				applyReceipt: null,
				error: null,
			});
			try {
				const status = TeamStatusSchema.parse(await call("mutation", "team.logout", {}));
				if (!disposed) store.setState({ status });
			} catch {
				if (!disposed) store.setState({ error: message });
			} finally {
				if (!disposed) store.setState({ busy: null });
				schedule();
			}
		},
		chooseOrganization(orgId: string) {
			epoch++;
			store.setState({
				orgId,
				repositories: [],
				detail: null,
				preview: null,
				applyReceipt: null,
				error: null,
			});
			return run("repositories", async () => repositories(orgId));
		},
		moreRepositories: () =>
			run("repositories", async () => {
				const s = store.getState();
				if (s.orgId && s.nextRepositoryOffset !== null)
					await repositories(s.orgId, s.nextRepositoryOffset);
			}),
		createOrganization(name: string) {
			return run("organization", async (version) => {
				const input = CreateOrganizationSchema.parse({
					name,
					requestId: request(`org:${name.trim()}`),
				});
				const result = TeamOrganizationSchema.parse(
					await call("mutation", "team.createOrganization", input)
				);
				if (!live(version)) return;
				store.setState({ orgId: result.id });
				await organizations();
			});
		},
		registerRepository(repository: string) {
			return run("repository", async (version) => {
				const orgId = store.getState().orgId;
				if (!orgId) return;
				const input = RegisterRepositorySchema.parse({
					orgId,
					repository,
					requestId: request(`repo:${orgId}:${repository}`),
				});
				TeamRepositorySchema.parse(await call("mutation", "team.registerRepository", input));
				if (live(version)) await repositories(orgId);
			});
		},
		selectScope(orgId: string, repositoryId: string) {
			return run("scope", async (version) => {
				const scope = TeamScopeSchema.parse(
					await call(
						"mutation",
						"team.selectScope",
						SelectScopeSchema.parse({ orgId, repositoryId })
					)
				);
				if (!live(version)) return;
				store.setState((state) => ({
					activeRepository: scope.repository,
					status: state.status
						? {
								...state.status,
								scopes: [
									...state.status.scopes.filter(
										(s) => s.repository.toLowerCase() !== scope.repository.toLowerCase()
									),
									scope,
								],
							}
						: null,
					detail: null,
					preview: null,
					applyReceipt: null,
				}));
				await proposals();
			});
		},
		refreshProposals: () => run("proposals", async () => proposals()),
		moreProposals: () =>
			run("proposals", async () => {
				const offset = store.getState().nextOffset;
				if (offset !== null) await proposals(offset);
			}),
		readProposal(proposalId: string) {
			epoch++;
			return run("proposal", async (version) => {
				store.setState({ detail: null, preview: null, applyReceipt: null });
				const s = store.getState();
				const detail = TeamProposalDetailSchema.parse(
					await call("query", "team.readProposal", {
						proposalId,
						repository: s.context.repository ?? s.activeRepository,
					})
				);
				if (live(version)) store.setState({ detail });
			});
		},
		previewLocal() {
			return run("preview", async (version) => {
				const s = store.getState();
				if (!s.context.candidateId) return;
				const preview = TeamLocalPreviewSchema.parse(
					await call(
						"query",
						"team.previewProposal",
						PreviewLocalProposalSchema.parse({
							candidateId: s.context.candidateId,
							repository: s.context.repository ?? s.activeRepository,
						})
					)
				);
				if (live(version)) store.setState({ preview, detail: null, applyReceipt: null });
			});
		},
		shareProposal(confirmed: boolean) {
			return run("share", async (version) => {
				const s = store.getState();
				if (!confirmed || !s.preview) throw new Error("Exact sharing confirmation required");
				const input = ShareLocalProposalSchema.parse({
					candidateId: s.preview.candidateId,
					bundleDigest: s.preview.bundleDigest,
					repository: s.context.repository ?? s.activeRepository,
					requestId: request(`share:${s.preview.candidateId}:${s.preview.bundleDigest}`),
					confirmed: true,
				});
				const result = TeamMutationResultSchema.parse(
					await call("mutation", "team.shareProposal", input)
				);
				if (!live(version)) return;
				store.setState({
					notice:
						result.status === "pending"
							? "Sharing is pending. Retry to check the same attempt."
							: "Proposal shared.",
					detail: result.proposal,
				});
				await proposals();
			});
		},
		decideProposal(choice: "accept" | "decline", confirmed: boolean) {
			return run("decision", async (version) => {
				const s = store.getState();
				if (!confirmed || !s.detail) throw new Error("Exact decision confirmation required");
				const input = DecideTeamProposalSchema.parse({
					proposalId: s.detail.id,
					bundleDigest: s.detail.bundleDigest,
					repository: s.context.repository ?? s.activeRepository,
					decision: choice,
					requestId: request(`decision:${s.detail.id}:${s.detail.bundleDigest}:${choice}`),
					confirmed: true,
				});
				const result = TeamMutationResultSchema.parse(
					await call("mutation", "team.decideProposal", input)
				);
				if (!live(version)) return;
				store.setState((state) => ({
					detail:
						state.detail && result.decision
							? { ...state.detail, decision: result.decision }
							: state.detail,
					notice:
						result.status === "pending"
							? "Decision is pending. Retry to check the same attempt."
							: "Author decision recorded.",
				}));
				await proposals();
			});
		},
		applyProposal(confirmed: boolean) {
			return run("apply", async (version) => {
				const s = store.getState();
				if (!confirmed || !s.detail || s.detail.decision?.decision !== "accept")
					throw new Error("Separate application confirmation required");
				const input = ApplyTeamProposalSchema.parse({
					proposalId: s.detail.id,
					bundleDigest: s.detail.bundleDigest,
					repository: s.context.repository ?? s.activeRepository,
					requestId: request(`apply:${s.detail.id}:${s.detail.bundleDigest}`),
					confirmed: true,
				});
				const receipt = TeamApplyReceiptSchema.parse(
					await call("mutation", "team.applyProposal", input)
				);
				if (live(version)) store.setState({ applyReceipt: receipt });
			});
		},
		dispose() {
			disposed = true;
			epoch++;
			started = false;
			clearTimeout(timer);
		},
	};
}
export type TeamController = ReturnType<typeof createTeamController>;
