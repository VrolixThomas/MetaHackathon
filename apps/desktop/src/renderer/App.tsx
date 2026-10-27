import { useEffect, useState } from "react";
import { ConversationApp } from "./conversation/ConversationApp";
import { createConversationApi } from "./conversation/api";
import { createConversationController } from "./conversation/controller";
import { connectShortcuts } from "./conversation/shortcuts";
import { connectConversationVoice } from "./conversation/voice";

export function App() {
	const [runtime] = useState(() => {
		const api = createConversationApi((input) => window.electron.trpc.request(input));
		return { api, controller: createConversationController(api) };
	});
	useEffect(() => {
		const disconnectVoice = connectConversationVoice(runtime.api, runtime.controller);
		const disconnectShortcuts = connectShortcuts(
			window.electron?.voiceShortcut,
			runtime.controller
		);
		void runtime.controller.configure();
		const release = () => runtime.controller.release();
		window.addEventListener("blur", release);
		return () => {
			window.removeEventListener("blur", release);
			disconnectShortcuts();
			runtime.controller.dispose();
			disconnectVoice();
		};
	}, [runtime]);
	return <ConversationApp controller={runtime.controller} />;
}
