import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "./MarkdownContent";

it("renders agent Markdown as semantic escaped content without active HTML or images", () => {
	const html = renderToStaticMarkup(
		<MarkdownContent
			markdown={[
				"# Actual explanation",
				"A **strong** point and *uncertainty*, with `realCode()`.",
				"",
				"- First fact",
				"- Second fact",
				"",
				"3. Third step",
				"4. Fourth step",
				"",
				"> Source is partial.",
				"",
				"```html",
				'<script>alert("source")</script>',
				"```",
				'<img src=x onerror="alert(1)">',
				"![image](https://example.com/private.png)",
			].join("\n")}
		/>
	);
	assert.match(html, /<h1>Actual explanation<\/h1>/);
	assert.match(html, /<strong>strong<\/strong>/);
	assert.match(html, /<ol start="3"><li>Third step/);
	assert.match(html, /<blockquote>Source is partial\.<\/blockquote>/);
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /&lt;img src=x/);
	assert.doesNotMatch(html, /<script|<img|<iframe|<svg|<[^>]*onerror=/);
});

it("permits only credential-free HTTP links and preserves unsupported content as text", () => {
	const html = renderToStaticMarkup(
		<MarkdownContent
			markdown={[
				"[safe](https://example.com/docs?q=1)",
				"[unsafe](javascript:alert)",
				"[data](data:text/html,attack)",
				"[credential](https://user:pass@example.com)",
				"[local](file:///secret)",
				"",
				"~~~",
				"unclosed code stays visible",
			].join("\n")}
		/>
	);
	assert.match(
		html,
		/href="https:\/\/example.com\/docs\?q=1" target="_blank" rel="noopener noreferrer"/
	);
	assert.equal((html.match(/<a /g) ?? []).length, 1);
	assert.match(html, /\[unsafe\]\(javascript:alert\)/);
	assert.match(html, /<pre><code>unclosed code stays visible<\/code><\/pre>/);
});
