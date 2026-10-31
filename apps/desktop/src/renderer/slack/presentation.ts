import type { ChatConversation } from "../../shared/contracts/chat";

export function isDirectMessage(conversation: ChatConversation) {
	return (
		conversation.visibility === "direct_message" ||
		conversation.visibility === "group_direct_message"
	);
}

export function conversationSymbol(conversation: ChatConversation) {
	return isDirectMessage(conversation)
		? "@"
		: conversation.visibility === "private_channel"
			? "▣"
			: "#";
}

export function visibilityLabel(conversation: ChatConversation) {
	return {
		public_channel: "Public channel",
		private_channel: "Private channel",
		direct_message: "Direct message",
		group_direct_message: "Group direct message",
	}[conversation.visibility];
}

/** Slack's bounded text tokens become inert text. Unsupported markup stays literal, React escapes it. */
export function slackPlainText(text: string, authors: Record<string, string>) {
	return text
		.replace(
			/<@([A-Z][A-Z0-9]+)>/g,
			(_, id: string) => `@${Object.hasOwn(authors, id) ? authors[id] : id}`
		)
		.replace(/<#[A-Z][A-Z0-9]+\|([^<>]+)>/g, (_, name: string) => `#${name}`)
		.replace(/<(https?:\/\/[^<>|\s]+)(?:\|([^<>]+))?>/g, (_, url: string, label?: string) =>
			label ? `${label} (${url})` : url
		)
		.replace(/<!(here|channel|everyone)>/g, (_, name: string) => `@${name}`)
		.replace(
			/&amp;|&lt;|&gt;/g,
			(entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[entity] ?? entity
		);
}
