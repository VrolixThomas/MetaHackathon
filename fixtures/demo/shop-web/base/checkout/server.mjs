import { createServer } from "node:http";
import { quote } from "./quote.ts";
import { PromoField } from "./PromoField.ts";

const port = Number(process.env.PORT ?? 0);
const runId = process.env.METAHACKATHON_RUN_ID;
if (!runId) throw new Error("Owned preview run ID is required");
const server = createServer((request, response) => {
	if (request.url === `/health?runId=${runId}`) {
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ runId }));
		return;
	}
	if (request.url !== `/checkout?runId=${runId}`) { response.writeHead(404); response.end(); return; }
	const total = quote({ subtotal: 120, code: "VIP30" }, { loyalty: { percent: 20 } }, {});
	response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'" });
	response.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seeded checkout</title><style>
body{margin:0;font:16px system-ui;background:#f6f4f0;color:#172124}.summary{box-sizing:border-box;width:min(100%,440px);padding:32px;margin:0 auto}p{line-height:1.65}strong{float:right}label{display:block;margin:20px 0}input{display:block;box-sizing:border-box;width:100%;padding:12px;margin-top:8px}button{padding:14px}.cap-note{max-width:210px}.pay{display:block;width:100%;margin-top:100px;background:#172124;color:white}@media(min-width:600px){.summary{width:560px}.cap-note{max-width:none}.pay{margin-top:32px}}
</style></head><body>${PromoField({ total, capped: total === 72 })}</body></html>`);
});
server.listen(port, "127.0.0.1", () => console.log(`METAHACKATHON_PREVIEW ${JSON.stringify({ runId, port: server.address().port })}`));
