import { useEffect, useState } from "react";
import { ConversationApp } from "./conversation/ConversationApp";
import { createConversationApi } from "./conversation/api";
import { createConversationController } from "./conversation/controller";
import { connectShortcuts } from "./conversation/shortcuts";
import { connectConversationVoice } from "./conversation/voice";
import { createPreparedApi } from "./prepared/api";
import { createPreparedController } from "./prepared/controller";

export function App() {
	const [runtime] = useState(() => {
		const api = createConversationApi((input) => window.electron.trpc.request(input));
		const controller = createConversationController(api);
		const reviews = createPreparedController(createPreparedApi(api.call), controller.sessionId);
		controller.attachReview(reviews);
		return { api, controller, reviews };
	});
	useEffect(() => {
		const disconnectVoice = connectConversationVoice(runtime.api, runtime.controller);
		const disconnectShortcuts = connectShortcuts(
			window.electron?.voiceShortcut,
			runtime.controller
		);
		void runtime.controller.configure();
		runtime.reviews.start();
		const release = () => runtime.controller.release();
		window.addEventListener("blur", release);
		return () => {
			window.removeEventListener("blur", release);
			disconnectShortcuts();
			runtime.controller.dispose();
			runtime.reviews.dispose();
			disconnectVoice();
		};
	}, [runtime]);
	return <ConversationApp controller={runtime.controller} reviews={runtime.reviews} />;
}
