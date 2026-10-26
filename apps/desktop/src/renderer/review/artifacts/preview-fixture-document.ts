import type { Preview } from "../../../shared/contracts";
import { fixtureDocumentHeight } from "./preview-model";

/** Script-free illustration. Shared marker bounds define the visible evidence positions. */
export function previewFixtureDocument(preview: Preview): string {
	if (preview.evidence.kind !== "fixture")
		throw new Error("Only fixture data can render an illustrative checkout");
	const phone = preview.viewport.mode === "phone";
	const cap = preview.markers.find((marker) => marker.id === "cap-note")?.bounds;
	const pay = preview.markers.find((marker) => marker.id === "pay")?.bounds;
	const left = phone ? 24 : 440;
	const width = phone ? 342 : 400;
	const capTop = cap?.y ?? 280;
	const capLeft = cap?.x ?? left;
	const capWidth = cap?.width ?? width;
	const payTop = pay?.y ?? 900;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:${fixtureDocumentHeight(preview)}px;overflow:hidden;background:#fff;color:#252a33;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px}h1{position:absolute;left:${left}px;top:32px;margin:0;font-size:24px;letter-spacing:-.5px}.items{position:absolute;left:${left}px;top:103px;width:${width}px}.row{display:flex;justify-content:space-between;gap:20px;margin-bottom:20px}.chip{background:#f0f2f4;border:1px solid #e0e4e8;border-radius:5px;padding:1px 7px}.cap{position:absolute;left:${capLeft}px;top:${capTop}px;width:${capWidth}px;margin:0;line-height:24px;color:#515762}.total{position:absolute;left:${left}px;top:${capTop + (cap?.height ?? 48) + 24}px;width:${width}px;border-top:1px solid #e4e7ec;padding-top:16px;font-weight:700;display:flex;justify-content:space-between}.pay{position:absolute;left:${pay?.x ?? left}px;top:${payTop}px;width:${pay?.width ?? width}px;height:${pay?.height ?? 48}px;background:#5a626e;color:white;border:0;border-radius:7px;display:flex;align-items:center;justify-content:center;font-weight:650}.caption{position:absolute;left:${left}px;top:69px;font-size:11px;color:#7a8391;letter-spacing:.5px;text-transform:uppercase}
</style></head><body><h1>Checkout</h1><div class="caption">Illustrative checkout · no payment</div><div class="items"><div class="row"><span>Subtotal</span><span>€120.00</span></div><div class="row"><span>Loyalty, Platinum</span><span>−€24.00</span></div><div class="row"><span class="chip">VIP30 ×</span><span>−€24.00</span></div></div><p class="cap">Discounts are capped at 40% of your order.</p><div class="total"><span>Total</span><span>€72.00</span></div><div class="pay">Pay €72.00</div></body></html>`;
}
