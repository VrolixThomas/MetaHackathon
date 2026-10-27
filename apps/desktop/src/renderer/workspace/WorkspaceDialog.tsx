import { type ReactNode, type RefObject, useEffect, useRef } from "react";

/** Wait for the native page to hide before entering the renderer's modal top layer. */
export function mountWorkspaceDialog(
	dialog: Pick<HTMLDialogElement, "showModal" | "close" | "open">,
	beforeOpen: (() => Promise<void>) | undefined,
	returnFocus: { isConnected: boolean; focus(): void } | null
) {
	let mounted = true;
	void Promise.resolve()
		.then(beforeOpen)
		.catch(() => {})
		.then(() => {
			if (mounted && !dialog.open) dialog.showModal();
		});
	return () => {
		mounted = false;
		if (dialog.open) dialog.close();
		if (returnFocus?.isConnected) returnFocus.focus();
	};
}

export function WorkspaceDialog({
	id,
	title,
	position = "right",
	className = "",
	children,
	onClose,
	beforeOpen,
	returnFocus,
}: {
	id: string;
	title: string;
	position?: "left" | "right" | "center";
	className?: string;
	children: ReactNode;
	onClose(): void;
	beforeOpen?: () => Promise<void>;
	returnFocus?: RefObject<HTMLButtonElement | null>;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const previous = returnFocus?.current ?? document.activeElement;
		if (!dialog.current) return;
		return mountWorkspaceDialog(
			dialog.current,
			beforeOpen,
			previous instanceof HTMLElement ? previous : null
		);
	}, [beforeOpen, returnFocus]);
	return (
		<dialog
			id={id}
			ref={dialog}
			className={`workspace-dialog ${className}`}
			data-position={position}
			aria-labelledby={`${id}-title`}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					onClose();
				}
			}}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onClick={(event) => {
				if (event.target !== event.currentTarget) return;
				const box = event.currentTarget.getBoundingClientRect();
				if (
					event.clientX < box.left ||
					event.clientX > box.right ||
					event.clientY < box.top ||
					event.clientY > box.bottom
				)
					onClose();
			}}
		>
			<header className="workspace-dialog-heading">
				<h2 id={`${id}-title`}>{title}</h2>
				<button
					type="button"
					className="quiet"
					aria-label={`Close ${title.toLowerCase()}`}
					onClick={onClose}
				>
					Close
				</button>
			</header>
			<div className="workspace-dialog-content">{children}</div>
		</dialog>
	);
}
