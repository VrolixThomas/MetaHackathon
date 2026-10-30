import { useEffect, useState } from "react";
import { createHubController } from "./command-center/controller";
import { ConversationApp } from "./conversation/ConversationApp";
import { createConversationApi } from "./conversation/api";
import { createAttentionBinding } from "./conversation/attention";
import { createAttentionSafety } from "./conversation/attention-safety";
import { createConversationController } from "./conversation/controller";
import { connectShortcuts } from "./conversation/shortcuts";
import { connectConversationVoice } from "./conversation/voice";
import { createPreparedApi } from "./prepared/api";
import { createPreparedController } from "./prepared/controller";
import { createWorkspaceController } from "./workspace/controller";
import { createLocalBrowserController } from "./workspace/local-browser";

export function App() {
	const [runtime] = useState(() => {
		const api = createConversationApi((input) => window.electron.trpc.request(input));
		const controller = createConversationController(api);
		const reviews = createPreparedController(createPreparedApi(api.call), controller.sessionId);
		controller.attachReview(reviews);
		const browser = createLocalBrowserController(api.call);
		const workspace = createWorkspaceController(api.call, reviews, browser, controller.sessionId, {
			onManualChange: controller.interruptReply,
		});
		controller.attachWorkspace(workspace);
		const hub = createHubController(api.call);
		return { api, controller, reviews, browser, workspace, hub };
	});
	useEffect(() => {
		const disconnectVoice = connectConversationVoice(runtime.api, runtime.controller);
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
			runtime.reviews.dispose();
			runtime.browser.dispose();
			disconnectVoice();
			void runtime.api
				.call("mutation", "workspace.release", { sessionId: runtime.controller.sessionId })
				.catch(() => {});
		};
	}, [runtime]);
	return (
		<ConversationApp
			controller={runtime.controller}
			reviews={runtime.reviews}
			browser={runtime.browser}
			workspace={runtime.workspace}
			hub={runtime.hub}
		/>
	);
}
