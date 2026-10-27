import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import superjson from "superjson";
import { Configuration } from "./ConversationApp";
import { createConversationApi } from "./api";
import { createConversationController } from "./controller";

function harness(signIn: () => Promise<{ login: string; avatar_url: string }>) {
	const calls: string[] = [];
	const controller = createConversationController(
		createConversationApi(async (request) => {
			calls.push(request.path);
			const value =
				request.path === "runtime.githubSignIn"
					? await signIn()
					: request.path === "runtime.reviewRequests"
						? []
						: undefined;
			return { result: { data: superjson.serialize(value) } };
		})
	);
	controller.store.setState({
		config: {
			envPath: "/test/.env",
			configured: { meta: true, elevenlabs: true, github: true },
			voiceId: "voice",
			microphone: "granted",
		},
	});
	const render = () =>
		renderToStaticMarkup(
			createElement(Configuration, {
				controller: {
					...controller,
					store: { ...controller.store, getInitialState: controller.store.getState },
				},
				onClose() {},
			})
		);
	return { controller, calls, render };
}

it("restores an explicit gh import control and displays pending and verified account status", async () => {
	let finish: (value: { login: string; avatar_url: string }) => void = () => {};
	const h = harness(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	try {
		const initial = h.render();
		assert.match(initial, /data-testid="github-connect"/);
		assert.match(initial, /Connect GitHub/);
		assert.match(initial, /Import your existing <code>gh<\/code> CLI sign-in/);
		assert.match(initial, /Configured · account not checked/);
		assert.doesNotMatch(initial, /type="password"/);
		assert.deepEqual(h.calls, [], "Rendering configuration must not initiate sign-in");
		const connecting = h.controller.refreshGitHub(true);
		const busy = h.render();
		assert.match(busy, /data-testid="github-connect"[^>]*disabled=""/);
		assert.match(busy, /data-testid="github-account-status">Connecting…/);
		finish({ login: "verified-account", avatar_url: "https://github.com/verified-account.png" });
		await connecting;
		const connected = h.render();
		assert.match(connected, /Connected as @verified-account/);
		assert.doesNotMatch(connected, /data-testid="github-connect"[^>]*disabled=/);
		assert.deepEqual(h.calls, ["runtime.githubSignIn", "runtime.reviewRequests"]);
	} finally {
		h.controller.dispose();
	}
});

it("shows GitHub errors and makes the existing import action available to retry", async () => {
	const h = harness(async () => {
		throw new Error("private upstream detail");
	});
	try {
		await h.controller.refreshGitHub(true);
		const failed = h.render();
		assert.match(failed, /Connection unavailable/);
		assert.match(failed, /role="alert">Could not load GitHub/);
		assert.doesNotMatch(
			failed,
			/private upstream detail|data-testid="github-connect"[^>]*disabled=/
		);
		h.controller.store.setState({
			account: { login: "previous-account", avatar_url: "https://github.com/previous-account.png" },
		});
		assert.match(h.render(), /Last account: @previous-account/);
	} finally {
		h.controller.dispose();
	}
});
