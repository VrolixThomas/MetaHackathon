import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceBar } from "./VoiceBar";
import { createConversationApi } from "./api";
import { createConversationController } from "./controller";

it("keeps a click-to-end control during startup and between hands-free turns", () => {
	const controller = createConversationController(
		createConversationApi(async () => {
			throw new Error("No IPC during render");
		})
	);
	const render = () =>
		renderToStaticMarkup(
			<VoiceBar
				controller={{
					...controller,
					store: { ...controller.store, getInitialState: controller.store.getState },
				}}
			/>
		);
	try {
		assert.match(render(), /aria-label="Start conversation" aria-pressed="false"/);
		assert.match(render(), /Hands-free off/);
		assert.doesNotMatch(render(), /Hold to talk|Stop response/);
		controller.store.setState({ handsFreeStarting: true });
		assert.match(render(), /aria-label="End conversation" aria-pressed="true"/);
		assert.match(render(), /Hands-free starting/);
		assert.doesNotMatch(render(), /data-testid="voice-control"[^>]*disabled/);
		controller.store.setState({
			handsFreeStarting: false,
			handsFree: true,
			phase: "idle",
			active: null,
		});
		assert.match(render(), /aria-label="End conversation"/);
		assert.match(render(), /Hands-free on/);
		assert.match(render(), /Listening…/);
		assert.doesNotMatch(render(), /Stop response/);
	} finally {
		controller.dispose();
	}
});

it("distinguishes reply interruption from ending a session, including typed replies", () => {
	const controller = createConversationController(
		createConversationApi(async () => {
			throw new Error("No IPC during render");
		})
	);
	const render = () =>
		renderToStaticMarkup(
			<VoiceBar
				controller={{
					...controller,
					store: { ...controller.store, getInitialState: controller.store.getState },
				}}
			/>
		);
	try {
		controller.store.setState({
			handsFree: true,
			phase: "speaking",
			active: { sessionId: controller.sessionId, turnId: "turn", generation: 1 },
		});
		assert.match(render(), /aria-label="End conversation"/);
		assert.match(render(), /aria-label="Stop response"/);
		assert.match(render(), /Speaking…/);
		controller.store.setState({ handsFree: false, phase: "thinking" });
		assert.match(render(), /aria-label="Start conversation"/);
		assert.match(render(), /aria-label="Stop response"/);
		assert.match(render(), /Thinking…/);
		assert.match(render(), /Hands-free off/);
	} finally {
		controller.dispose();
	}
});
