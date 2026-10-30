import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	OAUTH_CALLBACK_URLS,
	OAUTH_MESSAGES,
	type OAuthErrorCode,
} from "../../shared/contracts/oauth";
import type { ConversationApi } from "../conversation/api";
import { type OAuthController, createOAuthController } from "./controller";
import { OAuthConnections, OAuthProvider, useOAuth } from "./index";
import { connected, deferred, status, statuses } from "./test-support";

const controllers: OAuthController[] = [];
function controller(call: ConversationApi["call"] = async () => statuses()) {
	const value = createOAuthController(call);
	controllers.push(value);
	return value;
}
afterEach(() => {
	for (const value of controllers.splice(0)) value.dispose();
});

function render(value: OAuthController) {
	// Zustand SSR normally uses the factory's initial state. Supply the explicitly loaded snapshot.
	const supplied = { ...value, store: { ...value.store, getInitialState: value.store.getState } };
	return renderToStaticMarkup(
		<OAuthProvider controller={supplied}>
			<OAuthConnections />
		</OAuthProvider>
	);
}

function button(html: string, testId: string) {
	const match = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>[^<]*</button>`));
	assert.ok(match, `Missing button ${testId}`);
	return match[0];
}

it("legacy views without context render nothing and the hook returns null", () => {
	assert.equal(renderToStaticMarkup(<OAuthConnections />), "");
	function Probe() {
		return <span>{useOAuth() === null ? "no context" : "context"}</span>;
	}
	assert.equal(renderToStaticMarkup(<Probe />), "<span>no context</span>");
});

it("the root context shares the same controller and rendering never starts login or polling", () => {
	const value = controller(async () => {
		assert.fail("SSR unexpectedly called main");
	});
	function Probe() {
		assert.equal(useOAuth(), value);
		return <OAuthConnections />;
	}
	const html = renderToStaticMarkup(
		<OAuthProvider controller={value}>
			<Probe />
		</OAuthProvider>
	);
	assert.equal((html.match(/Checking connection…/g) ?? []).length, 2);
	assert.doesNotMatch(html, />Disconnected<|>Connected<|Disconnect<|Test User/);
	assert.match(button(html, "oauth-github-connect"), /disabled=""/);
	assert.match(button(html, "oauth-linear-connect"), /disabled=""/);
});

it("disconnected providers have stable sign-in controls and no invented account or disconnect action", async () => {
	const value = controller();
	await value.reload();
	const html = render(value);
	assert.equal((html.match(/>Disconnected<\/output>/g) ?? []).length, 2);
	assert.match(html, /data-testid="github-account-status"/);
	assert.match(html, /data-testid="linear-account-status"/);
	assert.match(button(html, "oauth-github-connect"), />Sign in with GitHub<\/button>/);
	assert.match(button(html, "oauth-linear-connect"), />Sign in with Linear<\/button>/);
	assert.doesNotMatch(button(html, "oauth-github-connect"), /disabled/);
	assert.doesNotMatch(
		html,
		/oauth-github-disconnect|oauth-linear-disconnect|Test User|@test-account/
	);
});

it("connected rows use actual public profiles and distinguish a local token from OAuth", async () => {
	const value = controller(async () =>
		statuses(
			connected("github", "octocat"),
			status("linear", {
				phase: "connected",
				source: "env",
				account: { id: "test-linear", displayName: "Actual Linear Name" },
			})
		)
	);
	await value.reload();
	const html = render(value);
	assert.match(html, /Test User \(@octocat\)/);
	assert.match(html, /Actual Linear Name/);
	assert.match(html, />Connected<\/output>/);
	assert.match(html, />Using local token<\/output>/);
	assert.match(button(html, "oauth-github-connect"), /Reconnect GitHub \(replace account\)/);
	assert.match(button(html, "oauth-linear-connect"), /Reconnect Linear \(replace account\)/);
	assert.match(button(html, "oauth-github-disconnect"), />Disconnect<\/button>/);
	assert.match(button(html, "oauth-linear-disconnect"), />Disconnect<\/button>/);
	assert.match(html, /Disconnect removes the local token/);
	assert.doesNotMatch(html, /Last account:/);
});

it("unconfigured providers offer main-owned setup with callback details and no credential inputs", async () => {
	const value = controller(async () =>
		statuses(
			status("github", { configurationReady: false }),
			status("linear", { configurationReady: false })
		)
	);
	await value.reload();
	const html = render(value);
	assert.match(button(html, "oauth-github-connect"), /Configure GitHub login/);
	assert.match(button(html, "oauth-linear-connect"), /Configure Linear login/);
	for (const url of Object.values(OAUTH_CALLBACK_URLS)) assert.ok(html.includes(url));
	assert.match(html, /<details[^>]*><summary>Login setup<\/summary>/);
	assert.match(html, /Reconnecting replaces the saved account/);
	assert.doesNotMatch(
		html,
		/<input|<textarea|client.?id|client.?secret|access.?token|refresh.?token/i
	);
});

it("connecting waits in the browser with Cancel and never presents the old profile as connected", async () => {
	const value = controller(async () =>
		statuses(
			status("github", {
				phase: "connecting",
				source: "oauth",
				account: connected("github", "prior-account").account,
			})
		)
	);
	await value.reload();
	const html = render(value);
	assert.match(html, />Continue in your browser<\/output>/);
	assert.match(button(html, "oauth-github-cancel"), />Cancel<\/button>/);
	assert.match(html, /Last account: Test User \(@prior-account\)/);
	assert.doesNotMatch(html, /oauth-github-connect|oauth-github-disconnect|>Connected<\/output>/);
});

it("one provider's pending mutation disables its controls while the other provider remains usable", async () => {
	const action = deferred<unknown>();
	const value = controller(async (_type, path) =>
		path === "oauth.status" ? statuses(connected("github")) : action.promise
	);
	await value.reload();
	const disconnect = value.disconnect("github");
	const html = render(value);
	assert.match(html, />Disconnecting…<\/output>/);
	assert.match(button(html, "oauth-github-connect"), /disabled=""/);
	assert.match(button(html, "oauth-github-disconnect"), /disabled=""/);
	assert.doesNotMatch(button(html, "oauth-linear-connect"), /disabled/);
	action.resolve(status("github"));
	await disconnect;
});

it("a cancelled reconnect or failed refresh retains Disconnect for the saved session", async () => {
	for (const error of ["cancelled", "refresh"] as const) {
		const value = controller(async () =>
			statuses({ ...connected("github", "saved-account"), phase: "error", error })
		);
		await value.reload();
		const html = render(value);
		assert.match(button(html, "oauth-github-disconnect"), />Disconnect<\/button>/);
		assert.match(button(html, "oauth-github-connect"), /Retry reconnect with GitHub/);
		assert.match(html, /Last account: Test User \(@saved-account\)/);
		assert.doesNotMatch(html, />Connected<\/output>/);
	}
});

it("pending start can be cancelled and queued cancellation stays busy until main acknowledges it", async () => {
	const action = deferred<unknown>();
	const value = controller(async (_type, path) =>
		path === "oauth.status" ? statuses() : action.promise
	);
	await value.reload();
	const login = value.connect("github");
	assert.match(render(value), />Opening sign-in…<\/output>/);
	assert.doesNotMatch(button(render(value), "oauth-github-cancel"), /disabled/);
	const cancel = value.cancel("github");
	const html = render(value);
	assert.match(html, />Cancelling…<\/output>/);
	assert.match(button(html, "oauth-github-cancel"), /disabled=""/);
	assert.doesNotMatch(html, /oauth-github-connect|>Connected<\/output>/);
	action.resolve(status("github"));
	await Promise.all([login, cancel]);
});

it("known backend error codes render only their fixed message and an explicit retry", async () => {
	for (const [error, message] of Object.entries(OAUTH_MESSAGES)) {
		const value = controller(async () =>
			statuses(status("github", { phase: "error", error: error as OAuthErrorCode }))
		);
		await value.reload();
		const html = render(value);
		assert.ok(html.includes(message));
		assert.match(html, /role="alert"/);
		assert.match(html, />Connection needs attention<\/output>/);
		assert.match(button(html, "oauth-github-connect"), />Retry<\/button>/);
		assert.doesNotMatch(html, /oauth-github-disconnect|>Connected<\/output>/);
	}
});

it("a failed disconnect remains an error after polling and labels retained profile metadata as last known", async () => {
	const value = controller(async (_type, path) => {
		if (path === "oauth.status") return statuses(connected("github", "known-account"));
		throw new Error("private upstream token and diagnostic");
	});
	await value.reload();
	await value.disconnect("github");
	await value.reload();
	const html = render(value);
	assert.match(html, />Connection needs attention<\/output>/);
	assert.ok(html.includes(OAUTH_MESSAGES.provider));
	assert.match(html, /Last account: Test User \(@known-account\)/);
	assert.match(
		button(html, "oauth-github-connect"),
		/Retry reconnect with GitHub \(replace account\)/
	);
	assert.doesNotMatch(html, />Connected<\/output>|private upstream|diagnostic/);
});

it("failed status reads show unavailable rather than disconnected and never render raw errors", async () => {
	const value = controller(async () => {
		throw new Error("private upstream credential");
	});
	await value.reload();
	const html = render(value);
	assert.equal((html.match(/>Connection status unavailable<\/output>/g) ?? []).length, 2);
	assert.ok(html.includes(OAUTH_MESSAGES.provider));
	assert.match(html, />Retry status<\/button>/);
	assert.doesNotMatch(
		html,
		/Disconnected|>Connected<\/output>|private upstream|credential<|<input/
	);
});

it("profile content stays escaped text and never renders avatars, scopes, or auth token fields", async () => {
	const value = controller(async () =>
		statuses(
			status("github", {
				phase: "connected",
				source: "oauth",
				scopes: ["public-test-scope"],
				account: {
					id: "public-id",
					displayName: "<script>alert('test')</script>",
					login: "test-login",
					avatarUrl: "https://example.test/avatar.png",
				},
			})
		)
	);
	await value.reload();
	const html = render(value);
	assert.match(html, /&lt;script&gt;/);
	assert.doesNotMatch(html, /<script|<img|example\.test|public-test-scope|<input|<textarea/);
});
