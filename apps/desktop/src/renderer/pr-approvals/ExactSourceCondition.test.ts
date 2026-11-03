import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExactSourceCondition } from "./ExactSourceCondition";

it("lists full paths/reasons with closed complete source disclosures, including exact special bytes", () => {
	const path = "apps/desktop/src/main/work/attention.ts";
	const content = readFileSync(new URL("../../main/work/attention.ts", import.meta.url), "utf8");
	const condition = {
		kind: "source" as const,
		path,
		reason: "Exact reviewed source",
		expectedContent: content,
	};
	const markup = renderToStaticMarkup(createElement(ExactSourceCondition, { condition }));
	assert(markup.includes(`${path}: Exact reviewed source</span><details><summary>`));
	assert(!markup.includes("<details open"));
	assert(markup.includes(`${Buffer.byteLength(content)} UTF-8 bytes`));
	// React's escaping must preserve the full source, rather than a preview or truncation.
	const escaped = (text: string) => renderToStaticMarkup(createElement("pre", null, text));
	assert(markup.includes(escaped(content)));
	assert(
		renderToStaticMarkup(
			createElement(ExactSourceCondition, {
				condition: { ...condition, expectedContent: "\uFEFFé\r\n<&>" },
			})
		).includes(escaped("\uFEFFé\r\n<&>"))
	);
});
