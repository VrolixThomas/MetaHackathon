import { Fragment, type ReactNode } from "react";

function safeLink(value: string) {
	try {
		const url = new URL(value);
		return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
			? url.href
			: null;
	} catch {
		return null;
	}
}

/** Deliberately small Markdown subset. Every source string remains escaped React text. */
function inline(text: string): ReactNode[] {
	const parts: ReactNode[] = [];
	const token = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
	let offset = 0;
	for (const match of text.matchAll(token)) {
		const start = match.index;
		parts.push(text.slice(offset, start));
		const key = start;
		if (match[1] !== undefined) parts.push(<code key={key}>{match[1]}</code>);
		else if (match[2] !== undefined) {
			const href = safeLink(match[3] ?? "");
			parts.push(
				href ? (
					<a key={key} href={href} target="_blank" rel="noopener noreferrer">
						{match[2]}
					</a>
				) : (
					<Fragment key={key}>{match[0]}</Fragment>
				)
			);
		} else if (match[4] !== undefined) parts.push(<strong key={key}>{match[4]}</strong>);
		else parts.push(<em key={key}>{match[5]}</em>);
		offset = start + match[0].length;
	}
	parts.push(text.slice(offset));
	return parts;
}

const listItem = (line: string) => /^\s{0,3}([-+*]|\d+\.)\s+(.+)$/.exec(line);
const isBlock = (line: string) =>
	/^\s*$|^\s{0,3}(?:#{1,6}\s|`{3,}|~{3,}|>\s?|(?:[-*_]\s*){3,}$)/.test(line) ||
	listItem(line) !== null;

export function MarkdownContent({ markdown }: { markdown: string }) {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const blocks: ReactNode[] = [];
	let row = 0;
	while (row < lines.length) {
		const line = lines[row] ?? "";
		const key = row++;
		if (!line.trim()) continue;
		const fence = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/.exec(line);
		if (fence) {
			const body: string[] = [];
			const closing = new RegExp(`^\\s{0,3}${fence[1]?.[0]}{${fence[1]?.length},}\\s*$`);
			while (row < lines.length && !closing.test(lines[row] ?? "")) body.push(lines[row++] ?? "");
			if (row < lines.length) row++;
			blocks.push(
				<pre key={key}>
					<code>{body.join("\n")}</code>
				</pre>
			);
			continue;
		}
		const heading = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
		if (heading) {
			const title = inline(heading[2] ?? "");
			const Heading =
				(["h1", "h2", "h3", "h4", "h5", "h6"] as const)[(heading[1]?.length ?? 1) - 1] ?? "h2";
			blocks.push(<Heading key={key}>{title}</Heading>);
			continue;
		}
		if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) {
			blocks.push(<hr key={key} />);
			continue;
		}
		const item = listItem(line);
		if (item) {
			const ordered = /\d/.test(item[1] ?? "");
			const items = [{ text: item[2] ?? "", row: key }];
			while (row < lines.length) {
				const next = listItem(lines[row] ?? "");
				if (!next || /\d/.test(next[1] ?? "") !== ordered) break;
				items.push({ text: next[2] ?? "", row });
				row++;
			}
			const children = items.map((item) => <li key={item.row}>{inline(item.text)}</li>);
			blocks.push(
				ordered ? (
					<ol key={key} start={Number.parseInt(item[1] ?? "1", 10)}>
						{children}
					</ol>
				) : (
					<ul key={key}>{children}</ul>
				)
			);
			continue;
		}
		if (/^\s{0,3}>/.test(line)) {
			const quote = [line.replace(/^\s{0,3}>\s?/, "")];
			while (row < lines.length && /^\s{0,3}>/.test(lines[row] ?? ""))
				quote.push((lines[row++] ?? "").replace(/^\s{0,3}>\s?/, ""));
			blocks.push(<blockquote key={key}>{inline(quote.join("\n"))}</blockquote>);
			continue;
		}
		const paragraph = [line];
		while (row < lines.length && !isBlock(lines[row] ?? "")) paragraph.push(lines[row++] ?? "");
		blocks.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
	}
	return <div className="canvas-markdown">{blocks}</div>;
}
