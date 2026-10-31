import { useEffect, useState } from "react";
import { OAuthProviderSchema } from "../shared/contracts/oauth";
import { createHubController } from "./command-center/controller";
import { ConversationApp } from "./conversation/ConversationApp";
import { createConversationApi } from "./conversation/api";
import { createAttentionBinding } from "./conversation/attention";
import { createAttentionSafety } from "./conversation/attention-safety";
import { createConversationController } from "./conversation/controller";
import { connectShortcuts } from "./conversation/shortcuts";
import { connectConversationVoice } from "./conversation/voice";
import { createDayApi, createDayController } from "./day";
import "./day/day.css";
import { OAuthProvider, createOAuthController } from "./oauth";
import { createPreparedApi } from "./prepared/api";
import { createPreparedController } from "./prepared/controller";
import { createWorkspaceController } from "./workspace/controller";
import { createLocalBrowserController } from "./workspace/local-browser";

export function App() {
	const [runtime] = useState(() => {
		const api = createConversationApi((input) => window.electron.trpc.request(input));
		const controller = createConversationController(api);
		const day = createDayController(createDayApi(api.call));
		const dayRef = { current: day };
		const reviews = createPreparedController(createPreparedApi(api.call), controller.sessionId);
		controller.attachReview(reviews);
		const browser = createLocalBrowserController(api.call);
		const workspace = createWorkspaceController(api.call, reviews, browser, controller.sessionId, {
			onManualChange: controller.interruptReply,
			ensureDayItem: async (id) => {
				const current = dayRef.current;
				await current.refresh();
				if (!current.store.getState().snapshot?.items.some((item) => item.id === id))
					await current.refresh();
				if (
					current !== dayRef.current ||
					!current.store.getState().snapshot?.items.some((item) => item.id === id)
				)
					throw new Error("Day item unavailable");
			},
		});
		controller.attachWorkspace(workspace);
		const hub = createHubController(api.call);
		const oauth = createOAuthController(api.call);
		return { api, controller, reviews, browser, workspace, hub, oauth, dayRef };
	});
	const [day, setDay] = useState(runtime.dayRef.current);
	useEffect(() => {
		const disconnectVoice = connectConversationVoice(
			runtime.api,
			runtime.controller,
			undefined,
			undefined,
			{ preconnect: import.meta.env["VITE_MUSE_VOICE_PRECONNECT"] !== "0" }
		);
		let accountIdentity: string | undefined;
		let slackIdentity: string | undefined;
		const disconnectAuth = runtime.oauth.store.subscribe((state) => {
			if (state.rows.length !== OAuthProviderSchema.options.length) return;
			const slack = state.rows.find((row) => row.provider === "slack");
			const nextSlack = `${slack?.source ?? "none"}:${slack?.account?.workspaceId ?? ""}:${slack?.account?.id ?? ""}`;
			if (slackIdentity !== undefined && slackIdentity !== nextSlack)
				window.dispatchEvent(new Event("muse:slack-account-change"));
			slackIdentity = nextSlack;
			const next = state.rows
				.filter((row) => row.provider !== "slack")
				.map((row) => `${row.provider}:${row.source ?? "none"}:${row.account?.id ?? ""}`)
				.join("|");
			if (accountIdentity !== undefined && accountIdentity !== next) {
				runtime.controller.interruptReply();
				void runtime.controller.configure();
				void runtime.hub.refresh();
				runtime.reviews.poll();
			}
			accountIdentity = next;
		});
		void runtime.oauth.start();
		const attentionSafety = createAttentionSafety(
			runtime.controller,
			window.electron?.attentionActivity
		);
		const attention = createAttentionBinding(runtime.api, runtime.controller, attentionSafety);
		const attentionTimer = setInterval(() => {
			void attention.poll();
		}, 1000);
		const disconnectShortcuts = connectShortcuts(
			window.electron?.voiceShortcut,
			runtime.controller,
			window
		);
		void runtime.controller.configure();
		runtime.reviews.start();
		runtime.browser.start();
		void runtime.workspace.start();
		runtime.hub.start();
		runtime.dayRef.current.start();
		const resetDay = () => {
			runtime.controller.interruptReply();
			runtime.controller.store.setState({ exchanges: [], attention: null });
			void runtime.api.release(runtime.controller.sessionId).catch(() => {});
			runtime.dayRef.current.dispose();
			const next = createDayController(createDayApi(runtime.api.call));
			runtime.dayRef.current = next;
			setDay(next);
			void next.start();
			const view = runtime.workspace.store.getState().workspace;
			const primary = view?.canvases.find((canvas) => canvas.id === view.primaryId);
			if (primary?.kind === "center" && primary.section === "day")
				void runtime.workspace.command({ kind: "open-center", section: "day" });
		};
		window.addEventListener("muse:slack-account-change", resetDay);
		const release = () => runtime.controller.release();
		const recordError = () => {
			void runtime.api
				.call("mutation", "diagnostics.record", { stage: "renderer-error" })
				.catch(() => {});
		};
		window.addEventListener("blur", release);
		window.addEventListener("error", recordError);
		window.addEventListener("unhandledrejection", recordError);
		return () => {
			disconnectAuth();
			runtime.oauth.dispose();
			clearInterval(attentionTimer);
			attention.dispose();
			attentionSafety.dispose();
			window.removeEventListener("blur", release);
			window.removeEventListener("error", recordError);
			window.removeEventListener("unhandledrejection", recordError);
			disconnectShortcuts();
			runtime.controller.dispose();
			runtime.workspace.dispose();
			runtime.hub.dispose();
			window.removeEventListener("muse:slack-account-change", resetDay);
			runtime.dayRef.current.dispose();
			runtime.reviews.dispose();
			runtime.browser.dispose();
			disconnectVoice();
			void runtime.api
				.call("mutation", "workspace.release", { sessionId: runtime.controller.sessionId })
				.catch(() => {});
		};
	}, [runtime]);
	return (
		<OAuthProvider controller={runtime.oauth}>
			<ConversationApp
				controller={runtime.controller}
				reviews={runtime.reviews}
				browser={runtime.browser}
				workspace={runtime.workspace}
				hub={runtime.hub}
				day={day}
			/>
		</OAuthProvider>
	);
}
