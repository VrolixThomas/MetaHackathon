import { useEffect, useRef, useState } from "react";
import { CredentialStatusListSchema } from "../../shared/contracts";
import { Icon } from "./Icons";
import { type CredentialProvider, type CredentialStatus, useServices } from "./services";

export function Settings({ onClose }: { onClose: () => void }) {
	const adapter = useServices((s) => s.settings);
	const [statuses, setStatuses] = useState<CredentialStatus[]>([]);
	const [editing, setEditing] = useState<CredentialProvider | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const previous = document.activeElement;
		dialog.current?.showModal();
		return () => {
			if (previous instanceof HTMLElement) previous.focus();
		};
	}, []);
	useEffect(() => {
		let active = true;
		adapter
			?.status()
			.then((value) => {
				if (active) setStatuses(CredentialStatusListSchema.parse(value));
			})
			.catch(() => {
				if (active) setMessage("Credential status is unavailable. Try again.");
			});
		return () => {
			active = false;
		};
	}, [adapter]);
	const run = async (action: () => Promise<void>) => {
		if (!adapter || busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setMessage("");
		try {
			await action();
			setStatuses(CredentialStatusListSchema.parse(await adapter.status()));
			setEditing(null);
			setMessage("Settings updated by the runtime.");
		} catch {
			setMessage("The runtime could not update settings. Check the connection and retry.");
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};
	return (
		<dialog
			className="settings-dialog"
			ref={dialog}
			aria-labelledby="settings-title"
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
		>
			<header>
				<h2 id="settings-title">Settings</h2>
				<button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}>
					<Icon name="close" />
				</button>
			</header>
			<div className="settings-content">
				<h3>Connections & credentials</h3>
				<p>
					Keys are passed directly to the runtime's credential service. Only connection status
					returns to this interface.
				</p>
				{!adapter && (
					<p className="attention-text">
						Runtime credential APIs are not connected. Key entry and GitHub sign-in will be
						available when the runtime adapter is installed.
					</p>
				)}
				{(["meta", "elevenlabs", "github"] as const).map((provider) => {
					const status = statuses.find((s) => s.provider === provider);
					const name = { meta: "Meta", elevenlabs: "ElevenLabs", github: "GitHub" }[provider];
					return (
						<div key={provider}>
							<div className="credential-row">
								<div>
									<strong>{name}</strong>
									<p>
										{status
											? status.configured
												? `Key saved · ${status.storage}`
												: "Not configured"
											: "Runtime unavailable"}
									</p>
								</div>
								{provider === "github" ? (
									<button
										type="button"
										className="button"
										disabled={!adapter || busy}
										onClick={() => run(() => adapter?.signInGitHub() ?? Promise.resolve())}
									>
										Sign in
									</button>
								) : (
									<button
										type="button"
										className="button"
										disabled={!adapter || busy}
										onClick={() => setEditing(editing === provider ? null : provider)}
									>
										{status?.configured ? "Replace key" : "Add key"}
									</button>
								)}
								{status?.configured && (
									<button
										type="button"
										className="text-button"
										disabled={busy}
										onClick={() => run(() => adapter?.remove(provider) ?? Promise.resolve())}
									>
										Remove
									</button>
								)}
							</div>
							{editing === provider && (
								<form
									className="credential-form"
									onSubmit={(event) => {
										event.preventDefault();
										const input = event.currentTarget.elements.namedItem("credential");
										if (!(input instanceof HTMLInputElement) || !input.value || !adapter) return;
										// Uncontrolled input, cleared synchronously. Never cache credentials in state or storage.
										const secret = input.value;
										input.value = "";
										void run(() => adapter.set(provider, secret));
									}}
								>
									<label htmlFor={`key-${provider}`}>{name} API key</label>
									<input
										id={`key-${provider}`}
										name="credential"
										type="password"
										autoComplete="off"
										spellCheck={false}
										disabled={busy}
										required
									/>
									<button className="button primary" type="submit" disabled={busy}>
										Save securely
									</button>
									<p>Sent once to the runtime. This interface never reads a saved key.</p>
								</form>
							)}
						</div>
					);
				})}
				{message && <output>{message}</output>}
				<div className="settings-divider" />
				<h3>Keyboard</h3>
				<div className="shortcut-list">
					<span>Move through the route</span>
					<kbd>J / K</kbd>
					<span>Open selected file</span>
					<kbd>Enter</kbd>
					<span>Close the current panel</span>
					<kbd>Esc</kbd>
					<span>Push to talk / interrupt speech</span>
					<kbd>Hold Space</kbd>
				</div>
				<div className="settings-divider" />
				<h3>About this workspace</h3>
				<p>
					Fixture mode illustrates the review flow. Code excerpts, scenario values, preview, and
					comments are labeled; they do not represent executed checks or posted reviews.
				</p>
			</div>
		</dialog>
	);
}
