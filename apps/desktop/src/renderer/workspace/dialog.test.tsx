import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceDialog, mountWorkspaceDialog } from "./WorkspaceDialog";

it("waits for native hide, opens a modal once, and returns focus to the stable opener", async () => {
	const events: string[] = [];
	let hidden = () => {};
	const pending = new Promise<void>((resolve) => {
		hidden = resolve;
	});
	const dialog = {
		open: false,
		showModal() {
			this.open = true;
			events.push("show");
		},
		close() {
			this.open = false;
			events.push("close");
		},
	};
	const unmount = mountWorkspaceDialog(
		dialog,
		async () => {
			events.push("hide");
			await pending;
		},
		{
			isConnected: true,
			focus() {
				events.push("focus");
			},
		}
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(events, ["hide"]);
	hidden();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(events, ["hide", "show"]);
	unmount();
	assert.deepEqual(events, ["hide", "show", "close", "focus"]);
});

it("a retired overlay never opens after a delayed native hide", async () => {
	let hidden = () => {};
	const pending = new Promise<void>((resolve) => {
		hidden = resolve;
	});
	let opened = false;
	const unmount = mountWorkspaceDialog(
		{
			open: false,
			showModal() {
				opened = true;
			},
			close() {},
		},
		() => pending,
		null
	);
	unmount();
	hidden();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(opened, false);
});

it("uses a named native dialog with a close control and a bounded content container", () => {
	const html = renderToStaticMarkup(
		<WorkspaceDialog
			id="repository-selector"
			title="Repositories and pull requests"
			position="left"
			onClose={() => {}}
		>
			<input aria-label="Repository" />
		</WorkspaceDialog>
	);
	assert.match(
		html,
		/<dialog[^>]*data-position="left"[^>]*aria-labelledby="repository-selector-title"/
	);
	assert.match(html, /aria-label="Close repositories and pull requests"/);
	assert.match(html, /class="workspace-dialog-content"/);
	assert.doesNotMatch(html, /open=""/);
});
