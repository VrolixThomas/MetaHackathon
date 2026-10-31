import { useEffect, useId, useMemo } from "react";
import { useStore } from "zustand";
import type { ConversationApi } from "../conversation/api";
import { type CodingProviderController, createCodingProviderController } from "./controller";
import {
	CODING_ERRORS,
	codingReady,
	museIssue,
	parseCodingSettings,
	publicTier,
	publicVersion,
	sameSettings,
} from "./model";
import "./coding.css";

const authLabels = {
	account: "Muse Code account",
	"api-key": "API key override",
	"sign-in-required": "Sign-in required",
	unknown: "Unknown",
};
const billingLabels = {
	subscription: "Subscription",
	"pay-as-you-go": "Pay-as-you-go",
	unknown: "Unknown",
};
const providerLabels = {
	"meta-api": "Meta API · pay-as-you-go",
	"muse-code": "Muse Code · existing CLI account/subscription",
};

export function CodingProviderForm({ controller }: { controller: CodingProviderController }) {
	const state = useStore(controller.store);
	const id = useId();
	const { status, draft } = state;
	const dirty = !!draft && (!status || !sameSettings(draft, status.settings));
	const ready = state.verified && codingReady(status);
	const cli = status?.museCode;
	const issue = cli ? museIssue(cli) : null;
	let invalidPath = false;
	if (draft) {
		try {
			parseCodingSettings(draft);
		} catch {
			invalidPath = true;
		}
	}
	return (
		<section
			className="coding-provider-card"
			aria-labelledby={`${id}-title`}
			data-coding-provider={status?.settings.provider ?? "unknown"}
			data-coding-ready={ready}
			data-coding-pending={state.pending ?? "none"}
		>
			<h3 id={`${id}-title`}>Background coding provider</h3>
			<p className="small">
				Choose how new background coding jobs are billed. There is no automatic fallback to API
				billing.
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void controller.save();
				}}
			>
				<fieldset disabled={!draft}>
					<legend>Provider for new jobs</legend>
					{(["muse-code", "meta-api"] as const).map((provider) => (
						<label className="coding-provider-choice" key={provider}>
							<input
								type="radio"
								name={`${id}-provider`}
								value={provider}
								checked={draft?.provider === provider}
								onChange={() => controller.setProvider(provider)}
							/>
							<span>
								{provider === "muse-code" ? (
									<>
										<strong>Muse Code</strong>
										<small>Use your existing CLI account and subscription.</small>
									</>
								) : (
									<>
										<strong>Meta API</strong>
										<small>Pay-as-you-go API billing with the app's configured key.</small>
									</>
								)}
							</span>
						</label>
					))}
				</fieldset>
				<details className="coding-provider-advanced">
					<summary>Advanced CLI path</summary>
					<label htmlFor={`${id}-path`}>Muse Code executable path (optional)</label>
					<input
						id={`${id}-path`}
						type="text"
						value={draft?.musePath ?? ""}
						maxLength={4096}
						spellCheck={false}
						autoComplete="off"
						disabled={!draft}
						placeholder="Auto"
						aria-invalid={invalidPath}
						aria-describedby={`${id}-path-help`}
						onChange={(event) => controller.setMusePath(event.target.value)}
					/>
					<p className="small" id={`${id}-path-help`}>
						Leave blank for Auto, or enter an absolute executable path. This saves configuration
						only; it does not install or change global CLI helpers.
					</p>
					{invalidPath && (
						<p className="inline-error" role="alert">
							{CODING_ERRORS.path}
						</p>
					)}
				</details>
				<div className="coding-provider-actions">
					<button type="submit" disabled={!draft || !dirty || invalidPath || !!state.pending}>
						{state.pending === "configure" ? "Saving…" : "Save coding provider"}
					</button>
					<button
						type="button"
						className="quiet"
						disabled={!!state.pending}
						onClick={() => void controller.refresh()}
					>
						{state.pending === "refresh" || state.pending === "status"
							? "Checking…"
							: "Refresh status"}
					</button>
				</div>
				{dirty && (
					<p className="small">
						Unsaved selection. Status below describes the saved provider and CLI path.
					</p>
				)}
			</form>
			<div className="coding-provider-status">
				<output aria-live="polite">
					{!status
						? state.pending
							? "Checking coding provider…"
							: "Status unavailable"
						: !state.verified
							? "Status not verified"
							: ready
								? "Ready for new coding jobs"
								: "Not ready for new coding jobs"}
				</output>
				{status && (
					<dl>
						<div>
							<dt>Saved provider</dt>
							<dd>{providerLabels[status.settings.provider]}</dd>
						</div>
						<div>
							<dt>Meta API key</dt>
							<dd>{status.metaApiConfigured ? "Configured" : "Not configured"}</dd>
						</div>
						<div>
							<dt>Muse Code CLI</dt>
							<dd>{cli?.installed ? "Installed" : "Not installed"}</dd>
						</div>
						<div>
							<dt>CLI version</dt>
							<dd>{publicVersion(cli?.version ?? null)}</dd>
						</div>
						<div>
							<dt>CLI sign-in</dt>
							<dd>{cli ? authLabels[cli.auth] : "Unknown"}</dd>
						</div>
						<div>
							<dt>CLI billing</dt>
							<dd>{cli ? billingLabels[cli.billing] : "Unknown"}</dd>
						</div>
						<div>
							<dt>CLI plan</dt>
							<dd>{publicTier(cli?.tier ?? null)}</dd>
						</div>
					</dl>
				)}
				{issue && (
					<p
						className="small"
						role={status?.settings.provider === "muse-code" ? "alert" : undefined}
					>
						{issue}
					</p>
				)}
				{status?.settings.provider === "meta-api" && !status.metaApiConfigured && (
					<p className="small">Configure the Meta API separately in the app configuration.</p>
				)}
			</div>
			{draft?.provider === "muse-code" && (
				<div className="coding-provider-login">
					<button
						type="button"
						disabled={!controller.canOpenLogin()}
						onClick={() => void controller.openLogin()}
					>
						{state.pending === "login" ? "Requesting sign-in…" : "Open Muse Code sign-in"}
					</button>
					<p className="small">
						Sign in through the official CLI flow opened by the app. Complete the vendor's browser
						steps yourself, then refresh status.
					</p>
					{dirty && (
						<p className="small">Save your provider and CLI path before opening sign-in.</p>
					)}
				</div>
			)}
			{state.error && (
				<p className="inline-error" role="alert">
					{CODING_ERRORS[state.error]}
				</p>
			)}
			{state.notice && <output aria-live="polite">{state.notice}</output>}
			<p className="small">
				New jobs use the latest saved selection. Existing jobs keep their pinned provider.
			</p>
			<p className="small">
				Foreground conversation, API configuration and voice stay separate. A Muse Code CLI account
				does not power ElevenLabs voice.
			</p>
		</section>
	);
}

/** Polling exists only while this settings card is mounted. No credential input or login automation. */
export function CodingProviderCard({ call }: { call: ConversationApi["call"] }) {
	const controller = useMemo(() => createCodingProviderController(call), [call]);
	useEffect(() => {
		void controller.start();
		return controller.stop;
	}, [controller]);
	return <CodingProviderForm controller={controller} />;
}
