import { useEffect, useState } from "react";
import { ConversationApp } from "./conversation/ConversationApp";
import { createConversationApi } from "./conversation/api";
import { createConversationController } from "./conversation/controller";
import { connectShortcuts } from "./conversation/shortcuts";
import { connectConversationVoice } from "./conversation/voice";
import { createPreparedApi } from "./prepared/api";
import { createPreparedController } from "./prepared/controller";
import { createLocalBrowserController } from "./workspace/local-browser";

export function App() {
	const [runtime] = useState(() => {
		const api = createConversationApi((input) => window.electron.trpc.request(input));
		const controller = createConversationController(api);
		const reviews = createPreparedController(createPreparedApi(api.call), controller.sessionId);
		controller.attachReview(reviews);
		return { api, controller, reviews, browser: createLocalBrowserController(api.call) };
	});
	useEffect(() => {
		const disconnectVoice = connectConversationVoice(runtime.api, runtime.controller);
		const disconnectShortcuts = connectShortcuts(
			window.electron?.voiceShortcut,
			runtime.controller,
			window
		);
		void runtime.controller.configure();
		runtime.reviews.start();
		runtime.browser.start();
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
			window.removeEventListener("blur", release);
			window.removeEventListener("error", recordError);
			window.removeEventListener("unhandledrejection", recordError);
			disconnectShortcuts();
			runtime.controller.dispose();
			runtime.reviews.dispose();
			runtime.browser.dispose();
			disconnectVoice();
		};
	}, [runtime]);
	return (
		<ConversationApp
			controller={runtime.controller}
			reviews={runtime.reviews}
			browser={runtime.browser}
		/>
	);
}
