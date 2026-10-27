import { createServer } from "node:http";
import { PromoField } from "./PromoField.ts";
import { quote } from "./quote.ts";

const port = Number(process.env.PORT ?? 0);
const runId = process.env.METAHACKATHON_RUN_ID;
if (!runId) throw new Error("Owned preview run ID is required");
const escapeHTML = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]
	);
const server = createServer((request, response) => {
	if (request.url === `/health?runId=${runId}`) {
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ runId }));
		return;
	}
	const url = new URL(request.url, "http://127.0.0.1");
	if (
		request.method !== "GET" ||
		url.searchParams.get("runId") !== runId ||
		!["/checkout", "/cart"].includes(url.pathname)
	) {
		response.writeHead(404);
		response.end();
		return;
	}
	const code = (url.searchParams.get("promo") ?? "VIP30").slice(0, 100);
	let total = 96;
	let error = "";
	try {
		total = quote({ subtotal: 120, code }, { loyalty: { percent: 20 } }, {});
	} catch (failure) {
		error = failure.message;
	}
	response.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy":
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	});
	response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seeded checkout</title><style>
body{margin:0;font:16px system-ui;background:#f6f4f0;color:#172124}.summary{box-sizing:border-box;width:min(100%,440px);padding:32px;margin:0 auto}p{line-height:1.65}strong{float:right}label{display:block;margin:20px 0}input{display:block;box-sizing:border-box;width:100%;padding:12px;margin-top:8px}button{padding:14px}.cap-note{max-width:210px}.pay{display:block;width:100%;margin-top:240px;background:#172124;color:white}@media(min-width:600px){.summary{width:560px}.cap-note{max-width:none}.pay{margin-top:32px}}
</style></head><body><nav><a href="/cart?runId=${runId}">Cart</a> · <a href="/checkout?runId=${runId}">Checkout</a></nav>${url.pathname === "/cart" ? `<section class="summary"><h1>Your cart</h1><p>Order subtotal €120.00</p><a href="/checkout?runId=${runId}">Continue to checkout</a></section>` : PromoField({ total, capped: total === 72, code: escapeHTML(code), error: escapeHTML(error), runId, paid: url.searchParams.get("pay") === "1" })}</body></html>`);
});
server.listen(port, "127.0.0.1", () =>
	console.log(`METAHACKATHON_PREVIEW ${JSON.stringify({ runId, port: server.address().port })}`)
);
