import { useStore } from "zustand";
import { OAUTH_MESSAGES, type OAuthProvider, type OAuthStatus } from "../../shared/contracts/oauth";
import { useOAuth } from "./context";
import { OAUTH_PROVIDERS, type OAuthController } from "./controller";
import "./oauth.css";

const names = { github: "GitHub", linear: "Linear" } as const;

function accountLabel(row: OAuthStatus) {
	if (!row.account) return "Account details unavailable";
	const { displayName, login } = row.account;
	return login ? `${displayName} (@${login})` : displayName;
}

function OAuthRows({ controller }: { controller: OAuthController }) {
	const state = useStore(controller.store);
	return (
		<section className="hub-setup oauth-connections" aria-label="Account connections">
			{state.error && (
				<div className="inline-error" role="alert">
					{OAUTH_MESSAGES[state.error]}{" "}
					<button
						type="button"
						className="quiet"
						disabled={state.loading}
						onClick={() => void controller.reload()}
					>
						Retry status
					</button>
				</div>
			)}
			{OAUTH_PROVIDERS.map((provider) => {
				const row = state.rows.find((item) => item.provider === provider);
				const pending = state.pending[provider];
				const error = state.errors[provider] ?? row?.error;
				const failed = !!error || row?.phase === "error";
				const connected = row?.phase === "connected" && row.source !== null;
				const connecting = row?.phase === "connecting" || pending === "connect";
				const status =
					pending === "cancel"
						? "Cancelling…"
						: pending === "disconnect"
							? "Disconnecting…"
							: pending === "connect"
								? "Opening sign-in…"
								: row?.phase === "connecting"
									? "Continue in your browser"
									: failed
										? "Connection needs attention"
										: state.error
											? "Connection status unavailable"
											: !row
												? "Checking connection…"
												: connected
													? row.source === "env"
														? "Using local token"
														: "Connected"
													: "Disconnected";
				return (
					<div className="oauth-row" key={provider} data-oauth-provider={provider}>
						<div className="oauth-account">
							<strong>{names[provider]}</strong>
							<output data-testid={`${provider}-account-status`} aria-live="polite">
								{status}
							</output>
							{row?.account && (
								<span className="small">
									{connected && !failed && !state.error && !pending ? "" : "Last account: "}
									{accountLabel(row)}
								</span>
							)}
							{failed && (
								<p className="inline-error" role="alert">
									{OAUTH_MESSAGES[error ?? "provider"]}
								</p>
							)}
						</div>
						<div className="hub-actions">
							{connecting || pending === "cancel" ? (
								<button
									type="button"
									className="quiet"
									data-testid={`oauth-${provider}-cancel`}
									disabled={!!pending && pending !== "connect"}
									onClick={() => void controller.cancel(provider)}
								>
									Cancel
								</button>
							) : (
								<ConnectButton
									provider={provider}
									row={row}
									pending={!!pending}
									failed={failed}
									controller={controller}
									setupBusy={state.setupBusy}
								/>
							)}
							{connected && (
								<button
									type="button"
									className="quiet"
									data-testid={`oauth-${provider}-disconnect`}
									disabled={!!pending}
									onClick={() => void controller.disconnect(provider)}
								>
									Disconnect
								</button>
							)}
						</div>
						{row && (
							<details className="oauth-help small">
								<summary>Login setup</summary>
								<p>
									Register this callback URL for {names[provider]}: <code>{row.callbackUrl}</code>
								</p>
								<p>
									Open the app .env file to configure login. Reconnecting replaces the saved
									account.
								</p>
								{row.source === "env" && (
									<p>
										Disconnect removes the local token. Application login settings are retained.
									</p>
								)}
							</details>
						)}
					</div>
				);
			})}
			{state.setupError && (
				<p className="inline-error" role="alert">
					{OAUTH_MESSAGES[state.setupError]}
				</p>
			)}
		</section>
	);
}

function ConnectButton({
	provider,
	row,
	pending,
	failed,
	controller,
	setupBusy,
}: {
	provider: OAuthProvider;
	row: OAuthStatus | undefined;
	pending: boolean;
	failed: boolean;
	controller: OAuthController;
	setupBusy: boolean;
}) {
	const configure = row?.configurationReady === false;
	const label = configure
		? `Configure ${names[provider]} login`
		: row?.phase === "connected"
			? `${failed ? "Retry reconnect with" : "Reconnect"} ${names[provider]} (replace account)`
			: failed
				? "Retry"
				: `Sign in with ${names[provider]}`;
	return (
		<button
			type="button"
			className="quiet"
			data-testid={`oauth-${provider}-connect`}
			disabled={!row || pending || (configure && setupBusy)}
			onClick={() => void (configure ? controller.openSetup() : controller.connect(provider))}
		>
			{label}
		</button>
	);
}

export function OAuthConnections() {
	const controller = useOAuth();
	return controller ? <OAuthRows controller={controller} /> : null;
}
